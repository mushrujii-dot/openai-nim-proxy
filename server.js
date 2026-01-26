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

// REASONING DISPLAY TOGGLE - Shows/hides reasoning in output
const SHOW_REASONING = true;

// THINKING MODE TOGGLE - Enables thinking for specific models that support it
const ENABLE_THINKING_MODE = true;

// Model mapping - TESTED RP MODELS
const MODEL_MAPPING = {
  'gpt-3.5-turbo': 'deepseek-ai/deepseek-v3',
  'gpt-4': 'deepseek-ai/deepseek-v3.1',
  'gpt-4-turbo': 'moonshotai/kimi-k2-thinking',
  'gpt-4o': 'deepseek-ai/deepseek-v3.1',
  'claude-3-opus': 'nvidia/llama-3.1-nemotron-ultra-253b-v1',
  'claude-3-sonnet': 'moonshotai/kimi-k2-instruct-0905',
  'gemini-pro': 'qwen/qwen3-next-80b-a3b-thinking'
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
    service: 'OpenAI to NVIDIA NIM Proxy',
    reasoning_display: SHOW_REASONING,
    thinking_mode: ENABLE_THINKING_MODE
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
      extra_body: ENABLE_THINKING_MODE ? { chat_template_kwargs: { thinking: true } } : undefined,
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
      console.error(`[ERROR] ${response.status}`);
      return res.status(response.status).json({
        error: {
          message: 'NVIDIA API error',
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
      
      let buffer = '';
      let reasoningStarted = false;
      
      response.data.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        
        lines.forEach(line => {
          if (line.startsWith('data: ')) {
            if (line.includes('[DONE]')) {
              res.write(line + '\n\n');
              return;
            }
            
            try {
              const data = JSON.parse(line.slice(6));
              if (data.choices && data.choices[0] && data.choices[0].delta) {
                const reasoning = data.choices[0].delta.reasoning_content;
                const content = data.choices[0].delta.content;
                
                if (SHOW_REASONING) {
                  let combinedContent = '';
                  
                  if (reasoning && !reasoningStarted) {
                    combinedContent = '<think>\n' + reasoning;
                    reasoningStarted = true;
                  } else if (reasoning) {
                    combinedContent = reasoning;
                  }
                  
                  if (content && reasoningStarted) {
                    combinedContent += '</think>\n\n' + content;
                    reasoningStarted = false;
                  } else if (content) {
                    combinedContent += content;
                  }
                  
                  if (combinedContent) {
                    data.choices[0].delta.content = combinedContent;
                    delete data.choices[0].delta.reasoning_content;
                  }
                } else {
                  if (content) {
                    data.choices[0].delta.content = content;
                  } else {
                    data.choices[0].delta.content = '';
                  }
                  delete data.choices[0].delta.reasoning_content;
                }
              }
              res.write(`data: ${JSON.stringify(data)}\n\n`);
            } catch (e) {
              res.write(line + '\n\n');
            }
          }
        });
      });
      
      response.data.on('end', () => {
        console.log(`[STREAM] Completed`);
        res.end();
      });
      
      response.data.on('error', (err) => {
        console.error('[STREAM ERROR]', err.message);
        res.end();
      });
    } else {
      // Non-streaming response
      if (!response.data || !response.data.choices) {
        console.error(`[INVALID] Missing choices`);
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
        choices: response.data.choices.map(choice => {
          let fullContent = choice.message?.content || '';
          
          if (SHOW_REASONING && choice.message?.reasoning_content) {
            fullContent = '<think>\n' + choice.message.reasoning_content + '\n</think>\n\n' + fullContent;
          }
          
          return {
            index: choice.index || 0,
            message: {
              role: choice.message?.role || 'assistant',
              content: fullContent
            },
            finish_reason: choice.finish_reason || 'stop'
          };
        }),
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
    console.error('[ERROR CODE]', error.code);
    
    // Handle timeout
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      return res.status(504).json({
        error: {
          message: 'Request timed out',
          type: 'timeout_error',
          code: 504
        }
      });
    }
    
    // Handle other errors safely
    let errorMessage = error.message || 'Internal server error';
    let errorStatus = 500;
    
    if (error.response) {
      errorStatus = error.response.status || 500;
      errorMessage = `NVIDIA API error (${errorStatus})`;
    }
    
    return res.status(errorStatus).json({
      error: {
        message: errorMessage,
        type: 'proxy_error',
        code: errorStatus
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
  console.log(`Reasoning: ${SHOW_REASONING}, Thinking: ${ENABLE_THINKING_MODE}`);
});

server.timeout = 120000;
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
