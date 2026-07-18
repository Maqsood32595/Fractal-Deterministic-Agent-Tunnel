const express = require('express');
const app = express();
const PORT = 8080;

// State
let instanceClass = 'db.t3.medium';
let maxConnections = 100;
let activeConnections = 35;
let anomalyActive = false;
let oomKilled = false;
let diskUsage = 42;

app.use(express.json());

// Health + DB check
app.get('/db-check', (req, res) => {
  const status = anomalyActive ? 'CRITICAL' : 'OK';
  res.json({
    status,
    instanceClass,
    activeConnections: anomalyActive ? 104 : activeConnections,
    maxConnectionsLimit: maxConnections,
    errorLog: anomalyActive
      ? `FATAL: Too many connections. Active: 104/${maxConnections}. Pool exhausted.`
      : 'All systems nominal.',
    podStatus: oomKilled ? 'OOMKilled' : 'Running',
    diskUsage: diskUsage,
    latency: anomalyActive ? 4200 : 65,
    httpErrorRate: anomalyActive ? 0.72 : 0.01,
    timestamp: new Date().toISOString()
  });
});

// Prometheus metrics endpoint
app.get('/metrics', (req, res) => {
  const connections = anomalyActive ? 104 : activeConnections;
  const errorRate = anomalyActive ? 0.72 : 0.01;
  res.set('Content-Type', 'text/plain');
  res.send(`
# HELP db_active_connections Current number of active DB connections
# TYPE db_active_connections gauge
db_active_connections ${connections}

# HELP db_max_connections Maximum allowed DB connections
# TYPE db_max_connections gauge
db_max_connections ${maxConnections}

# HELP http_error_rate Current HTTP error rate (0-1)
# TYPE http_error_rate gauge
http_error_rate ${errorRate}

# HELP disk_usage_percent Current disk usage percentage
# TYPE disk_usage_percent gauge
disk_usage_percent ${diskUsage}

# HELP oom_killed_status 1 if pod is OOMKilled, 0 if healthy
# TYPE oom_killed_status gauge
oom_killed_status ${oomKilled ? 1 : 0}
  `.trim());
});

// Inject anomaly (DB saturation)
app.post('/simulate-anomaly', (req, res) => {
  anomalyActive = true;
  res.json({ success: true, message: 'DB saturation anomaly injected.' });
});

// Inject OOMKilled
app.post('/simulate-oom', (req, res) => {
  oomKilled = true;
  res.json({ success: true, message: 'OOMKilled anomaly injected.' });
});

// Inject disk spike
app.post('/simulate-disk', (req, res) => {
  diskUsage = 98;
  res.json({ success: true, message: 'Disk usage spiked to 98%.' });
});

// Cascade simulation (for watchdog testing)
app.post('/simulate-cascade', (req, res) => {
  anomalyActive = true;
  oomKilled = true;
  diskUsage = 97;
  res.json({ success: true, message: 'Cascading failure injected.' });
});

// Reset all state
app.post('/reset', (req, res) => {
  instanceClass = 'db.t3.medium';
  maxConnections = 100;
  activeConnections = 35;
  anomalyActive = false;
  oomKilled = false;
  diskUsage = 42;
  res.json({ success: true, message: 'All state reset to healthy baseline.' });
});

// Apply fix (called after PR merge)
app.post('/apply-fix', (req, res) => {
  const { scenario } = req.body;
  if (scenario === 1) {
    instanceClass = 'db.r6g.large';
    maxConnections = 500;
    anomalyActive = false;
  } else if (scenario === 2) {
    diskUsage = 42;
  } else if (scenario === 3) {
    oomKilled = false;
  }
  res.json({ success: true, instanceClass, maxConnections, diskUsage, oomKilled });
});

app.listen(PORT, () => {
  console.log(`[Target API] Running on http://localhost:${PORT}`);
});
