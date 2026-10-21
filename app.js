// app.js - Main application entry point

import express from 'express';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

import productRoutes from './src/routes/products.js';
import proposalRoutes from './src/routes/proposals.js';
import agentRoutes from './src/routes/agent.js';
import lookupRoutes from './src/routes/lookup.js';
import runRoutes from './src/routes/runs.js';
import { closeStaleRuns } from './src/runner.js';
import { startScheduler } from './src/scheduler.js';
import { markupOptions } from './src/utils/pricing.js';

const app = express();
const PORT = process.env.PORT || 8006;
const __dirname = path.resolve();

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/config', (req, res) => {
  res.json({ success: true, markupOptions: markupOptions() });
});

app.use('/api/products', productRoutes);
app.use('/api/proposals', proposalRoutes);
app.use('/api/agent', agentRoutes);
app.use('/api/lookup', lookupRoutes);
app.use('/api/runs', runRoutes);

// Static pages
const page = (name) => (req, res) => res.sendFile(path.join(__dirname, 'views', `${name}.html`));
app.get('/', page('index'));
app.get('/history', page('history'));
app.get('/products', page('products'));
app.get('/lookup', page('lookup'));

app.listen(PORT, () => {
  console.log(`Luxtronic Daily Price Approval running on port ${PORT}`);
  closeStaleRuns().then(startScheduler).catch((error) => console.error('Startup tasks failed:', error.message));
});
