// server.js - OpenAI to NVIDIA NIM API Proxy
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const http = require('http');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

// HTTP agent with keep-alive and longer timeouts
const httpAgent = new http.Agent({ 
  keepAlive: true,
  keepAliveMsecs: 60000,
  timeout: 120000
});

const httpsAgent = new https.Agent({ 
  keepAlive: true,
  keepAliveMsecs: 60000,
  timeout: 120000
});

// Middleware
app.use(cors());
app.use(express.json());

// Increase timeouts
app.use((req, res, next) => {
  req.setTimeout(120000);
  res.setTimeout(120000);
  next();
});

// NVIDIA NIM API configuration
const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

// Model mapping - FAST MODELS
const MODEL_MAPPING = {
  'gpt-3.5-turbo': 'meta/llama-3.1-8b-instruct',
  'gpt-4': 'meta/llama-3.1-70b-instruct',
  'gpt-4-turbo': 'meta/llama-3.3-70b-instruct',
  'gpt-4o': 'meta/llama-3.3-70b-instruct',
  'claude-3-opus': 'meta/llama-3.1-70b-instruct',
  'claude-3-sonnet': 'meta/llama-3.1-8b-instruct',
  'gemini-pro': 'nvidia/llama-3.1-nemotron-70b-instruct'
};

// Root endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'OpenAI to NVIDIA NIM Proxy',
    message: 'Proxy is running. Use /v1/chat/completions endpoint.'
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'OpenAI to NVIDIA NIM Proxy'
  });
});

// List models endpoint
app.get('/v1/models', (req, res) => {
  const models = Object.keys(MODEL_MAPPING).map(model => ({
    id: model,
    object: 'model',
    created: Date.now(),
    owned_by: 'nvidia-nim-proxy'
  }));
  
  res.json({
    object: 'list',
    data: models
  });
});

// Chat completions endpoint
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model, messages, temperature, max_tokens, stream } = req.body;
    
    console.log(`[REQUEST] Model: ${model}, Stream: ${stream}, MaxTokens: ${max_tokens}`);
    
    // Get NVIDIA model
    let nimModel = MODEL_MAPPING[model] || 'meta/llama-3.1-8b-instruct';
    console.log(`[NVIDIA] Using model: ${nimModel}`);
    
    // Transform request
    const nimRequest = {
      model: nimModel,
      messages: messages,
      temperature: temperature || 0.7,
      top_p: 1,
      max_tokens: Math.min(max_tokens || 1024, 2048),
      stream: stream || false
    };
    
    console.log(`[API CALL] Starting request...`);
    
    // Make request to NVIDIA
    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
      headers: {
        'Authorization': `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      responseType: stream ? 'stream' : 'json',
      timeout: 90000,
      httpAgent: httpAgent,
      httpsAgent: httpsAgent,
      validateStatus: (status) => status < 600
    });
    
    console.log(`[NVIDIA] Response status: ${response.status}`);
    
    if (response.status !== 200) {
      console.error(`[ERROR] ${response.status}: ${JSON.stringify(response.data)}`);
      return res.status(response.status).json({
        error: {
          message: response.data?.error?.message || 'NVIDIA API error',
          type: 'api_error',
          code: response.status
        }
      });
    }
    
    if (stream) {
      console.log(`[STREAM] Starting...`);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      response.data.on('data', (chunk) => {
        res.write(chunk);
      });
      
      response.data.on('end', () => {
        console.log(`[STREAM] Completed`);
        res.end();
      });
      
      response.data.on('error', (err) => {
        console.error('[STREAM ERROR]', err);
        res.end();
      });
    } else {
      // Non-streaming response
      if (!response.data || !response.data.choices) {
        console.error(`[INVALID] Missing choices:`, response.data);
        return res.status(500).json({
          error: {
            message: 'Invalid response from NVIDIA',
            type: 'api_error',
            code: 500
          }
        });
      }
      
      const openaiResponse = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: response.data.choices.map(choice => ({
          index: choice.index || 0,
          message: {
            role: choice.message?.role || 'assistant',
            content: choice.message?.content || ''
          },
          finish_reason: choice.finish_reason || 'stop'
        })),
        usage: response.data.usage || {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0
        }
      };
      
      console.log(`[SUCCESS] Sent ${openaiResponse.choices[0].message.content.length} chars`);
      res.json(openaiResponse);
    }
    
  } catch (error) {
    console.error('[ERROR]', error.message);
    
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      return res.status(504).json({
        error: {
          message: 'Request timed out',
          type: 'timeout_error',
          code: 504
        }
      });
    }
    
    res.status(error.response?.status || 500).json({
      error: {
        message: error.message || 'Internal server error',
        type: 'proxy_error',
        code: 500
      }
    });
  }
});

// Catch-all
app.all('*', (req, res) => {
  if (req.path === '/' || req.path === '/health') return;
  res.status(404).json({
    error: {
      message: `Endpoint ${req.path} not found`,
      type: 'invalid_request_error',
      code: 404
    }
  });
});

const server = app.listen(PORT, () => {
  console.log(`OpenAI to NVIDIA NIM Proxy running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});

server.timeout = 120000;
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
