const http = require('http');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET' && req.url === '/api/health') {
    res.writeHead(200);
    res.end(JSON.stringify({
      status: 'ok',
      service: 'KC Earn API'
    }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({
    error: 'Route not found'
  }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`KC Earn API running on port ${PORT}`);
});
