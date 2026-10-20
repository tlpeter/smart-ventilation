'use strict';

// Options from the app's Configuration tab in Home Assistant.
// The Supervisor writes them to /data/options.json; changing them restarts the app.

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || '/data';
const DEFAULTS = {
  log_level: 'info',
  publish_sensors: false,
};

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'options.json'), 'utf8'));
    const merged = { ...DEFAULTS, ...raw };
    merged.publish_sensors = merged.publish_sensors === true;
    if (!['debug', 'info', 'warning', 'error'].includes(merged.log_level)) merged.log_level = 'info';
    return merged;
  } catch {
    return { ...DEFAULTS };
  }
}

module.exports = { options: load(), DATA_DIR };
