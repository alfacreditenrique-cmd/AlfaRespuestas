module.exports = (req, res) => {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({
    ok: true,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    now: new Date().toISOString()
  }));
};
