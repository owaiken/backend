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
const wss = new WebSocket.Server({ server });

// Enable CORS with specific settings
app.use(cors({
  origin: '*', // Allow all origins
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
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
  const url = new URL(req.url, 'http://localhost');
  const previewId = url.searchParams.get('previewId');
  
  if (!previewId) {
    ws.close();
    return;
  }
  
  console.log(`New WebSocket connection for preview: ${previewId}`);
  
  // Get or create container
  let container = containers.get(previewId);
  if (!container) {
    container = createContainer(previewId);
    containers.set(previewId, container);
    console.log(`Created new container for preview: ${previewId}`);
  }
  
  // Add this client to the container
  container.clients.add(ws);
  
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      console.log(`Received message from client: ${JSON.stringify(data)}`);
      
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
    container.clients.delete(ws);
    
    // Clean up empty containers after some time
    if (container.clients.size === 0) {
      setTimeout(() => {
        if (containers.get(previewId)?.clients.size === 0) {
          // Clean up container resources
          console.log(`Cleaning up container for preview: ${previewId}`);
          containers.delete(previewId);
        }
      }, 300000); // 5 minutes
    }
  });
});

// Broadcast to all clients for a container
function broadcastToContainer(previewId, data) {
  const container = containers.get(previewId);
  if (container) {
    const message = JSON.stringify(data);
    console.log(`Broadcasting to container ${previewId}: ${message}`);
    
    for (const client of container.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }
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

// API endpoint for executing code
app.post('/api/execute/:previewId', express.json(), (req, res) => {
  const { previewId } = req.params;
  const { command, args = [], cwd = '/', terminal = null } = req.body;
  
  // Log terminal options if provided
  if (terminal) {
    console.log(`Terminal options provided: cols=${terminal.cols}, rows=${terminal.rows}`);
  }
  
  if (!command) {
    return res.status(400).json({ error: 'Missing command parameter' });
  }
  
  let container = containers.get(previewId);
  if (!container) {
    container = createContainer(previewId);
    containers.set(previewId, container);
  }
  
  try {
    const processId = uuidv4();
    const workingDir = path.join(container.dir, cwd);
    
    // Ensure working directory exists
    fs.mkdirSync(workingDir, { recursive: true });
    
    console.log(`Executing command in container ${previewId}: ${command} ${args.join(' ')}`);
    
    // Special handling for shell commands
    let commandToExecute = command;
    let argsToUse = [...args];
    
    // Handle /bin/jsh command specially
    if (command === '/bin/jsh') {
      console.log('Detected jsh shell command, using bash instead');
      commandToExecute = '/bin/bash';
      // If args contain --osc, remove it as it's specific to jsh
      argsToUse = args.filter(arg => arg !== '--osc');
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
    const isInteractiveShell = commandToExecute === '/bin/bash';
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
    console.error(`Error executing command:`, error);
    res.status(500).json({ error: error.message });
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

// Start server
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
