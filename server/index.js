const path = require('path');
const express = require('express');
require('./db'); // ensures schema exists
const routes = require('./routes');
const { initScheduler } = require('./sync');
const recorder = require('./recorder');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use('/api', routes);
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`DPTV Recorder listening on port ${PORT}`);
  initScheduler();
  recorder.init();
});
