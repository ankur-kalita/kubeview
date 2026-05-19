const express = require("express");
const cors = require("cors");
const k8s = require("./lib/k8s-client");
const t = require("./lib/transformers");

const app = express();
const PORT = 5501;

app.use(cors({ origin: "http://localhost:5500" }));
app.use(express.json());

// @kubernetes/client-node v1 errors don't expose the HTTP status as a single
// stable property — depending on the path the error took it can land on
// `code`, `statusCode`, or `status`, and for "unknown" status codes (e.g.
// 400s from log endpoints) only the formatted `message` carries it. Likewise,
// the K8s Status object's human-readable message is often buried inside the
// stringified body. These helpers paper over that.
function getStatusCode(err) {
  if (!err) return 0;
  if (typeof err.code === "number") return err.code;
  if (typeof err.statusCode === "number") return err.statusCode;
  if (typeof err.status === "number") return err.status;
  if (typeof err.message === "string") {
    const match = err.message.match(/HTTP-Code:\s*(\d+)/);
    if (match) return parseInt(match[1], 10);
  }
  return 0;
}

function getApiMessage(err) {
  if (!err) return "Internal server error";
  if (err.body && typeof err.body === "object" && typeof err.body.message === "string") {
    return err.body.message;
  }
  if (typeof err.message === "string") {
    const bodyMatch = err.message.match(/Body:\s*"((?:[^"\\]|\\.)*)"/);
    if (bodyMatch) {
      try {
        const decoded = bodyMatch[1].replace(/\\"/g, '"').replace(/\\n/g, "\n");
        const parsed = JSON.parse(decoded);
        if (parsed && typeof parsed.message === "string") return parsed.message;
      } catch (_) {
        // fall through to using err.message
      }
    }
    return err.message;
  }
  return "Internal server error";
}

// Health check
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Cluster info
app.get("/api/cluster", async (_req, res, next) => {
  try {
    const info = await k8s.getClusterInfo();
    res.json(info);
  } catch (err) {
    next(err);
  }
});

// Namespaces
app.get("/api/namespaces", async (_req, res, next) => {
  try {
    const items = await k8s.listNamespaces();
    res.json(items.map(t.transformNamespace));
  } catch (err) {
    next(err);
  }
});

// Pods
app.get("/api/pods", async (req, res, next) => {
  try {
    const ns = req.query.namespace;
    const items = await k8s.listPods(ns || undefined);
    res.json(items.map(t.transformPod));
  } catch (err) {
    next(err);
  }
});

// Pod detail
app.get("/api/pods/:namespace/:name", async (req, res, next) => {
  try {
    const pod = await k8s.getPod(req.params.namespace, req.params.name);
    res.json(t.transformPod(pod));
  } catch (err) {
    if (getStatusCode(err) === 404) {
      return res.status(404).json({ error: "Pod not found" });
    }
    next(err);
  }
});

// Pod logs
app.get("/api/pods/:namespace/:name/logs", async (req, res, next) => {
  try {
    const { container, tailLines } = req.query;
    const logs = await k8s.getPodLogs(
      req.params.namespace,
      req.params.name,
      container || undefined,
      tailLines ? parseInt(tailLines) : 100
    );
    res.json({ logs: logs || "" });
  } catch (err) {
    if (getStatusCode(err) === 404) {
      return res.status(404).json({ error: "Pod not found" });
    }
    next(err);
  }
});

// Deployments
app.get("/api/deployments", async (req, res, next) => {
  try {
    const ns = req.query.namespace;
    const items = await k8s.listDeployments(ns || undefined);
    res.json(items.map(t.transformDeployment));
  } catch (err) {
    next(err);
  }
});

// Services
app.get("/api/services", async (req, res, next) => {
  try {
    const ns = req.query.namespace;
    const items = await k8s.listServices(ns || undefined);
    res.json(items.map(t.transformService));
  } catch (err) {
    next(err);
  }
});

// Nodes
app.get("/api/nodes", async (_req, res, next) => {
  try {
    const items = await k8s.listNodes();
    res.json(items.map(t.transformNode));
  } catch (err) {
    next(err);
  }
});

// Events
app.get("/api/events", async (req, res, next) => {
  try {
    const ns = req.query.namespace;
    const items = await k8s.listEvents(ns || undefined);
    res.json(items.map(t.transformEvent));
  } catch (err) {
    next(err);
  }
});

// Error handler
app.use((err, _req, res, _next) => {
  console.error("API Error:", err.message);
  const status = getStatusCode(err) || 500;
  res.status(status).json({
    error: getApiMessage(err),
    status,
  });
});

app.listen(PORT, () => {
  console.log(`KubeView API running on http://localhost:${PORT}`);
});
