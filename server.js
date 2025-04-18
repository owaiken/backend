const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');

const app = express();
const server = http.createServer(app);

// Configure WebSocket server with proper error handling
const wss = new WebSocket.Server({ 
  server,
  // Allow connections from any origin
  verifyClient: (info) => {
    console.log(`[WebSocket] Connection attempt from origin: ${info.origin}`);
    return true; // Accept all connections
  }
});

// Direct CORS handling middleware - applied before any routes
app.use((req, res, next) => {
  console.log(`[CORS] Request from origin: ${req.headers.origin || 'unknown'} to path: ${req.path} method: ${req.method}`);
  
  // Always set these headers for all responses
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, HEAD, PATCH');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Max-Age', '86400'); // 24 hours
  
  // Security headers
  res.header('Cross-Origin-Resource-Policy', 'cross-origin');
  res.header('Cross-Origin-Embedder-Policy', 'credentialless');
  res.header('Cross-Origin-Opener-Policy', 'same-origin');
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    console.log(`[CORS] Handling OPTIONS preflight request for path: ${req.path}`);
    return res.status(204).end();
  }
  
  next();
});

// Apply CORS to all routes as a fallback
app.use(cors());

// Handle OPTIONS requests globally with explicit headers
app.options('*', (req, res) => {
  console.log(`[CORS] Global OPTIONS handler for path: ${req.path}`);
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, HEAD, PATCH');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.status(204).end();
});

// Health check endpoint for Fly.io
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '1.0.0',
    containers: wss.clients.size,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    timestamp: new Date().toISOString()
  });
});
app.use(express.json());

// Apply rate limiting - with higher limits for development
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 1000, // Limit each IP to 1000 requests per minute
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  message: 'Too many requests from this IP, please try again after 1 minute',
  skip: (req, res) => {
    // Skip rate limiting for health checks
    return req.path === '/api/health';
  }
});

// Apply rate limiting to API endpoints except health
app.use('/api/', apiLimiter);

// Store active containers
const containers = new Map();

// Create a container for a preview
function createContainer(previewId) {
  // Use the persistent volume mounted at /data
  const containerDir = path.join('/data', previewId);
  fs.mkdirSync(containerDir, { recursive: true });
  
  return {
    id: previewId,
    dir: containerDir,
    clients: new Set(),
    files: new Map(),
    processes: new Map()
  };
}

// WebSocket handling
wss.on('connection', (ws, req) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const previewId = url.searchParams.get('previewId');
    const processId = url.searchParams.get('processId');
    
    // Log connection details
    console.log(`[WebSocket] New connection: ${req.url}`);
    console.log(`[WebSocket] Headers:`, JSON.stringify(req.headers));
    console.log(`[WebSocket] Preview ID: ${previewId}, Process ID: ${processId || 'none'}`);
    
    if (!previewId) {
      console.log(`[WebSocket] Closing connection - missing previewId`);
      ws.close(1008, 'Missing previewId parameter');
      return;
    }
    
    // Get or create container
    let container = containers.get(previewId);
    if (!container) {
      console.log(`[WebSocket] Creating new container for preview: ${previewId}`);
      container = createContainer(previewId);
      containers.set(previewId, container);
    }
    
    // Add this client to the container
    container.clients.add(ws);
    console.log(`[WebSocket] Client added to container. Total clients: ${container.clients.size}`);
    
    // Send connection acknowledgment
    ws.send(JSON.stringify({
      type: 'connection-established',
      previewId,
      processId,
      timestamp: Date.now(),
      clientCount: container.clients.size
    }));
    
    // Set up ping/pong to keep connection alive
    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, 30000);
    
    // Handle pong responses
    ws.on('pong', () => {
      console.log(`[WebSocket] Received pong from client for preview: ${previewId}`);
    });
    
    ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      console.log(`[WebSocket] Received message from client for preview: ${previewId}:`, JSON.stringify(data));
      
      // Validate message has a type
      if (!data.type) {
        console.error('[WebSocket] Message missing type field');
        ws.send(JSON.stringify({
          type: 'error',
          error: 'Missing type field in message',
          timestamp: Date.now()
        }));
        return;
      }
      
      // Ensure container exists
      const container = containers.get(previewId);
      if (!container) {
        console.error(`Container not found for preview: ${previewId}`);
        ws.send(JSON.stringify({
          type: 'error',
          error: 'Container not found',
          previewId,
          timestamp: Date.now()
        }));
        return;
      }
      
      // Handle different message types
      if (data.type === 'file-change') {
        // Notify all clients for this container
        broadcastToContainer(previewId, {
          type: 'refresh-preview',
          previewId
        });
      } else if (data.type === 'preview-ready') {
        // Notify all clients that preview is ready
        broadcastToContainer(previewId, {
          type: 'preview-ready',
          previewId,
          url: `/preview/${previewId}`,
          timestamp: Date.now()
        });
      } else if (data.type === 'terminal-input') {
        // Handle terminal input
        const { processId, input } = data;
        
        if (!processId || !input) {
          console.error('Missing processId or input for terminal-input');
          return;
        }
        
        // Find the process
        const process = container.processes.get(processId);
        if (!process) {
          console.error(`Process ${processId} not found for terminal input`);
          return;
        }
        
        // Write to the process stdin
        if (process.stdin) {
          console.log(`Writing to process ${processId} stdin: ${input.length} characters`);
          process.stdin.write(input);
        } else {
          console.error(`Process ${processId} has no stdin`);
        }
      } else if (data.type === 'terminal-resize') {
        // Handle terminal resize
        const { processId, cols, rows } = data;
        
        if (!processId || !cols || !rows) {
          console.error('Missing processId, cols, or rows for terminal-resize');
          return;
        }
        
        // Find the process
        const process = container.processes.get(processId);
        if (!process) {
          console.error(`Process ${processId} not found for terminal resize`);
          return;
        }
        
        // Resize the terminal if supported
        if (process.resize) {
          console.log(`Resizing terminal for process ${processId} to ${cols}x${rows}`);
          process.resize({ cols, rows });
        } else {
          console.log(`Process ${processId} does not support resize`);
        }
      }
    } catch (error) {
      console.error('Error processing WebSocket message:', error);
    }
  });
  
  ws.on('close', () => {
    console.log(`WebSocket connection closed for preview: ${previewId}`);
    
    // Remove client from container
    const container = containers.get(previewId);
    if (container) {
      container.clients.delete(ws);
      console.log(`Removed client from container ${previewId}, ${container.clients.size} clients remaining`);
      
      // Clean up empty containers after some time
      if (container.clients.size === 0) {
        console.log(`No clients left for container ${previewId}, scheduling cleanup in 5 minutes`);
        setTimeout(() => {
          if (containers.get(previewId)?.clients.size === 0) {
            // Clean up container resources
            console.log(`Cleaning up container for preview: ${previewId}`);
            containers.delete(previewId);
          }
        }, 300000); // 5 minutes
      }
    } else {
      console.error(`Cannot remove client: Container not found for preview: ${previewId}`);
    }
  });
  
  // Handle WebSocket errors
  ws.on('error', (error) => {
    console.error(`WebSocket error for preview ${previewId}:`, error);
    
    try {
      // Send error to client if still connected
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'error',
          error: 'WebSocket connection error',
          message: error.message,
          timestamp: Date.now()
        }));
      }
    } catch (sendError) {
      console.error('Error sending error message to client:', sendError);
    }
  });
  } catch (error) {
    console.error(`[WebSocket] Error in connection handler:`, error);
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(1011, 'Internal server error');
    }
  }
});

// Broadcast to all clients for a container
function broadcastToContainer(previewId, data) {
  const container = containers.get(previewId);
  if (!container) {
    console.error(`Cannot broadcast: Container not found for preview: ${previewId}`);
    return;
  }
  
  const message = JSON.stringify(data);
  const clientCount = container.clients.size;
  console.log(`Broadcasting message to ${clientCount} clients for preview ${previewId}: ${data.type}`);
  
  let sentCount = 0;
  for (const client of container.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
      sentCount++;
    }
  }
  
  console.log(`Successfully sent message to ${sentCount}/${clientCount} clients`);
}

// API endpoints for file operations
app.post('/api/files/write/:previewId', express.json(), (req, res) => {
  const { previewId } = req.params;
  const { path: filePath, content } = req.body;
  
  if (!filePath || content === undefined) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }
  
  let container = containers.get(previewId);
  if (!container) {
    container = createContainer(previewId);
    containers.set(previewId, container);
  }
  
  try {
    // Create directories if needed
    const dirPath = path.dirname(path.join(container.dir, filePath));
    fs.mkdirSync(dirPath, { recursive: true });
    
    // Write file
    fs.writeFileSync(path.join(container.dir, filePath), content);
    
    // Store file in memory for quick access
    container.files.set(filePath, content);
    
    // Notify clients of file change
    broadcastToContainer(previewId, {
      type: 'file-change',
      previewId,
      path: filePath
    });
    
    res.json({ success: true });
  } catch (error) {
    console.error(`Error writing file ${filePath}:`, error);
    res.status(500).json({ error: error.message });
  }
});

// API endpoint for creating directories
app.post('/api/files/mkdir/:previewId', express.json(), (req, res) => {
  const { previewId } = req.params;
  const { path: dirPath, recursive = true } = req.body;
  
  if (!dirPath) {
    return res.status(400).json({ error: 'Missing path parameter' });
  }
  
  let container = containers.get(previewId);
  if (!container) {
    container = createContainer(previewId);
    containers.set(previewId, container);
  }
  
  try {
    // Create directory
    const fullPath = path.join(container.dir, dirPath);
    fs.mkdirSync(fullPath, { recursive });
    
    console.log(`Created directory ${dirPath} for preview: ${previewId}`);
    
    res.json({ success: true });
  } catch (error) {
    console.error(`Error creating directory ${dirPath}:`, error);
    res.status(500).json({ error: error.message });
  }
});

// API endpoint for reading directory contents
app.get('/api/files/readdir/:previewId', (req, res) => {
  const { previewId } = req.params;
  const { path: dirPath } = req.query;
  const withFileTypes = req.query.withFileTypes === 'true';
  
  if (!dirPath) {
    return res.status(400).json({ error: 'Missing path parameter' });
  }
  
  const container = containers.get(previewId);
  if (!container) {
    return res.status(404).json({ error: 'Container not found' });
  }
  
  try {
    // Read directory
    const fullPath = path.join(container.dir, dirPath);
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'Directory not found' });
    }
    
    const entries = fs.readdirSync(fullPath, { withFileTypes });
    
    if (withFileTypes) {
      // Convert Dirent objects to serializable objects
      const serializedEntries = entries.map(entry => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
        isSymbolicLink: entry.isSymbolicLink()
      }));
      
      return res.json({ entries: serializedEntries });
    }
    
    return res.json({ entries });
  } catch (error) {
    console.error(`Error reading directory ${dirPath}:`, error);
    res.status(500).json({ error: error.message });
  }
});

// API endpoint for removing files or directories
app.post('/api/files/rm/:previewId', express.json(), (req, res) => {
  const { previewId } = req.params;
  const { path: filePath, recursive = false } = req.body;
  
  if (!filePath) {
    return res.status(400).json({ error: 'Missing path parameter' });
  }
  
  const container = containers.get(previewId);
  if (!container) {
    return res.status(404).json({ error: 'Container not found' });
  }
  
  try {
    // Remove file or directory
    const fullPath = path.join(container.dir, filePath);
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'File or directory not found' });
    }
    
    if (fs.statSync(fullPath).isDirectory()) {
      fs.rmdirSync(fullPath, { recursive });
    } else {
      fs.unlinkSync(fullPath);
    }
    
    // Remove from memory cache if it exists
    container.files.delete(filePath);
    
    console.log(`Removed ${filePath} for preview: ${previewId}`);
    
    // Notify clients of file change
    broadcastToContainer(previewId, {
      type: 'file-change',
      previewId,
      path: filePath
    });
    
    res.json({ success: true });
  } catch (error) {
    console.error(`Error removing ${filePath}:`, error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/files/read/:previewId', (req, res) => {
  const { previewId } = req.params;
  const { path: filePath } = req.query;
  
  if (!filePath) {
    return res.status(400).json({ error: 'Missing path parameter' });
  }
  
  const container = containers.get(previewId);
  if (!container) {
    return res.status(404).json({ error: 'Container not found' });
  }
  
  try {
    // Check if file exists in memory
    if (container.files.has(filePath)) {
      return res.json({ content: container.files.get(filePath) });
    }
    
    // Read from filesystem
    const fullPath = path.join(container.dir, filePath);
    if (fs.existsSync(fullPath)) {
      const content = fs.readFileSync(fullPath, 'utf-8');
      container.files.set(filePath, content);
      return res.json({ content });
    }
    
    res.status(404).json({ error: 'File not found' });
  } catch (error) {
    console.error(`Error reading file ${filePath}:`, error);
    res.status(500).json({ error: error.message });
  }
});

// Handle OPTIONS requests for execute endpoint specifically
app.options('/api/execute/:previewId', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.status(204).end();
});

// API endpoint for executing code
app.post('/api/execute/:previewId', express.json(), (req, res) => {
  try {
    console.log(`[EXECUTE] Received request for preview: ${req.params.previewId}`);
    console.log(`[EXECUTE] Request body:`, JSON.stringify(req.body));
    console.log(`[EXECUTE] Origin:`, req.headers.origin);
    console.log(`[EXECUTE] Content-Type:`, req.headers['content-type']);
    
    // Explicitly set CORS headers for this critical endpoint
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    res.header('Access-Control-Allow-Credentials', 'true');
    
    const { previewId } = req.params;
    const { command, args = [], cwd = '/', terminal = null } = req.body;
    
    // Log terminal options if provided
    if (terminal) {
      console.log(`[EXECUTE] Terminal options provided: cols=${terminal.cols}, rows=${terminal.rows}`);
    }
    
    if (!command) {
      console.log(`[EXECUTE] Error: Missing command parameter`);
      return res.status(400).json({ error: 'Missing command parameter' });
    }
    
    console.log(`[EXECUTE] Looking for container: ${previewId}`);
    console.log(`[EXECUTE] Available containers: ${Array.from(containers.keys()).join(', ')}`);
    
    let container = containers.get(previewId);
    if (!container) {
      console.log(`[EXECUTE] Container not found, creating new container for: ${previewId}`);
      container = createContainer(previewId);
      containers.set(previewId, container);
    }
    
    const processId = uuidv4();
    const workingDir = path.join(container.dir, cwd);
    
    // Ensure working directory exists
    fs.mkdirSync(workingDir, { recursive: true });
    
    console.log(`[EXECUTE] Process ID: ${processId}`);
    console.log(`[EXECUTE] Working directory: ${workingDir}`);
    console.log(`[EXECUTE] Executing command in container ${previewId}: ${command} ${args.join(' ')}`);
    
    // Special handling for shell commands
    let commandToExecute = command;
    let argsToUse = [...args];
    
    // Handle /bin/jsh command specially
    if (command === '/bin/jsh') {
      console.log('[EXECUTE] Detected jsh shell command, using sh instead');
      commandToExecute = '/bin/sh';
      // If args contain --osc, remove it as it's specific to jsh
      argsToUse = args.filter(arg => arg !== '--osc');
    }
    
    // Handle /bin/bash command specially (for Alpine Linux compatibility)
    if (command === '/bin/bash') {
      console.log('[EXECUTE] Detected bash shell command, using sh instead');
      commandToExecute = '/bin/sh';
    }
    
    console.log(`Modified command: ${commandToExecute} ${argsToUse.join(' ')}`);
    
    // Prepare exec options
    const execOptions = {
      cwd: workingDir,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        TERM_PROGRAM: 'bolt'
      }
    };
    
    // If terminal dimensions are provided, use them
    if (terminal && terminal.cols && terminal.rows) {
      execOptions.env.COLUMNS = terminal.cols.toString();
      execOptions.env.LINES = terminal.rows.toString();
    }
    
    // Use spawn instead of exec for interactive shells to get access to stdin
    const isInteractiveShell = commandToExecute === '/bin/sh';
    let childProcess;
    
    if (isInteractiveShell) {
      // Use spawn for interactive shells
      const { spawn } = require('child_process');
      childProcess = spawn(commandToExecute, argsToUse, {
        ...execOptions,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      
      // Add resize method for terminal resizing
      childProcess.resize = ({ cols, rows }) => {
        try {
          // We can't directly resize the terminal, but we can set environment variables
          // that the shell might use
          process.env.COLUMNS = cols.toString();
          process.env.LINES = rows.toString();
          console.log(`Set terminal size to ${cols}x${rows}`);
        } catch (error) {
          console.error('Error resizing terminal:', error);
        }
      };
      
      // Handle process exit
      childProcess.on('exit', (code) => {
        console.log(`Process ${processId} exited with code ${code}`);
        container.processes.delete(processId);
        
        // Notify clients of process completion
        broadcastToContainer(previewId, {
          type: 'process-completed',
          previewId,
          processId,
          exitCode: code || 0,
          stdout: '', // We've already streamed the output
          stderr: ''
        });
      });
      
      // Stream stdout
      childProcess.stdout.on('data', (data) => {
        const output = data.toString();
        broadcastToContainer(previewId, {
          type: 'process-output',
          previewId,
          processId,
          output,
          stream: 'stdout'
        });
      });
      
      // Stream stderr
      childProcess.stderr.on('data', (data) => {
        const output = data.toString();
        broadcastToContainer(previewId, {
          type: 'process-output',
          previewId,
          processId,
          output,
          stream: 'stderr'
        });
      });
    } else {
      // Use exec for non-interactive commands
      childProcess = exec(
        `${commandToExecute} ${argsToUse.join(' ')}`,
        execOptions,
        (error, stdout, stderr) => {
          // Process completed
          container.processes.delete(processId);
          
          // Notify clients of process completion
          broadcastToContainer(previewId, {
            type: 'process-completed',
            previewId,
            processId,
            exitCode: error ? error.code : 0,
            stdout,
            stderr
          });
        }
      );
      
      // Stream stdout
      childProcess.stdout.on('data', (data) => {
        broadcastToContainer(previewId, {
          type: 'process-output',
          previewId,
          processId,
          output: data.toString(),
          stream: 'stdout'
        });
      });
      
      // Stream stderr
      childProcess.stderr.on('data', (data) => {
        broadcastToContainer(previewId, {
          type: 'process-output',
          previewId,
          processId,
          output: data.toString(),
          stream: 'stderr'
        });
      });
    }
    
    // Store process reference
    container.processes.set(processId, childProcess);
    
    // Send initial response with process ID
    res.json({ processId });
    
    // Set up output streaming
    let stdout = '';
    let stderr = '';
    
    childProcess.stdout.on('data', (data) => {
      stdout += data.toString();
      broadcastToContainer(previewId, {
        type: 'process-output',
        previewId,
        processId,
        output: data.toString(),
        stream: 'stdout'
      });
    });
    
    childProcess.stderr.on('data', (data) => {
      stderr += data.toString();
      broadcastToContainer(previewId, {
        type: 'process-output',
        previewId,
        processId,
        output: data.toString(),
        stream: 'stderr'
      });
    });
  } catch (error) {
    console.error(`[EXECUTE] Error executing command:`, error);
    console.error(`[EXECUTE] Stack trace:`, error.stack);
    
    // Ensure CORS headers are set even in error responses
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    res.header('Access-Control-Allow-Credentials', 'true');
    
    res.status(500).json({
      error: error.message,
      stack: error.stack,
      previewId: req.params.previewId
    });
  }
});

// Serve preview content
app.get('/preview/:previewId', (req, res) => {
  const { previewId } = req.params;
  
  const container = containers.get(previewId);
  if (!container) {
    return res.status(404).send('Preview not found');
  }
  
  // Check if index.html exists in container
  const indexPath = path.join(container.dir, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Preview ${previewId}</title>
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
              padding: 2rem;
              max-width: 800px;
              margin: 0 auto;
              line-height: 1.5;
            }
            h1 {
              color: #333;
            }
            .message {
              padding: 1rem;
              background-color: #f8f9fa;
              border-radius: 4px;
              border-left: 4px solid #6c757d;
            }
          </style>
        </head>
        <body>
          <h1>Preview ${previewId}</h1>
          <div class="message">
            <p>No content to display yet. Create an index.html file to see your preview.</p>
          </div>
        </body>
      </html>
    `);
  }
});

// Serve static files from container
app.get('/preview/:previewId/*', (req, res) => {
  const { previewId } = req.params;
  const filePath = req.path.replace(`/preview/${previewId}/`, '');
  
  const container = containers.get(previewId);
  if (!container) {
    return res.status(404).send('Preview not found');
  }
  
  const fullPath = path.join(container.dir, filePath);
  if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
    res.sendFile(fullPath);
  } else {
    res.status(404).send('File not found');
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '1.0.0',
    containers: containers.size,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    timestamp: new Date().toISOString()
  });
});

// Simple root endpoint for basic connectivity check
app.get('/', (req, res) => {
  res.send('Fly.io backend is running');
});

// Preview endpoint for serving content
app.get('/preview/:previewId', (req, res) => {
  const { previewId } = req.params;
  
  // Set special headers for preview iframe
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  const container = containers.get(previewId);
  if (!container) {
    return res.status(404).send(`Preview ${previewId} not found. It may have been cleaned up due to inactivity.`);
  }
  
  // Serve index.html from the container directory if it exists
  const indexPath = path.join(container.dir, 'index.html');
  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }
  
  // If no index.html, try to find any HTML file
  const files = fs.readdirSync(container.dir, { withFileTypes: true });
  const htmlFiles = files.filter(file => file.isFile() && file.name.endsWith('.html'));
  
  if (htmlFiles.length > 0) {
    return res.sendFile(path.join(container.dir, htmlFiles[0].name));
  }
  
  // If no HTML files, return a directory listing
  const fileList = files.map(file => {
    return `<li><a href="/preview/${previewId}/${file.name}">${file.name}</a></li>`;
  }).join('');
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Preview ${previewId}</title>
      <style>
        body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
      </style>
    </head>
    <body>
      <h1>Directory listing for preview ${previewId}</h1>
      <ul>${fileList}</ul>
    </body>
    </html>
  `);
});

// Serve static files from preview containers
app.get('/preview/:previewId/*', (req, res) => {
  const { previewId } = req.params;
  const filePath = req.params[0] || '';
  
  // Set special headers for preview content
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  const container = containers.get(previewId);
  if (!container) {
    return res.status(404).send(`Preview ${previewId} not found. It may have been cleaned up due to inactivity.`);
  }
  
  const fullPath = path.join(container.dir, filePath);
  if (!fs.existsSync(fullPath)) {
    return res.status(404).send(`File not found: ${filePath}`);
  }
  
  if (fs.statSync(fullPath).isDirectory()) {
    // If directory, try to serve index.html
    const indexPath = path.join(fullPath, 'index.html');
    if (fs.existsSync(indexPath)) {
      return res.sendFile(indexPath);
    }
    
    // If no index.html, return directory listing
    const files = fs.readdirSync(fullPath, { withFileTypes: true });
    const fileList = files.map(file => {
      const isDir = file.isDirectory();
      return `<li><a href="/preview/${previewId}/${filePath}/${file.name}${isDir ? '/' : ''}">${file.name}${isDir ? '/' : ''}</a></li>`;
    }).join('');
    
    return res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Directory ${filePath}</title>
        <style>
          body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
        </style>
      </head>
      <body>
        <h1>Directory listing for ${filePath || '/'}</h1>
        <ul>${fileList}</ul>
      </body>
      </html>
    `);
  }
  
  // Serve the file
  res.sendFile(fullPath);
});

// Start server
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
