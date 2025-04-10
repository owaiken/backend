const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Enable CORS
app.use(cors());
app.use(express.json());

// Store active containers
const containers = new Map();

// Create a container for a preview
function createContainer(previewId) {
  // This is a simplified example - you'd use Docker API in production
  const containerDir = path.join('/tmp', previewId);
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
  const { command, args = [], cwd = '/' } = req.body;
  
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
    
    // Execute command
    const childProcess = exec(
      `${command} ${args.join(' ')}`,
      { cwd: workingDir },
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

// Start server
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
