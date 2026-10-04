#!/usr/bin/env node
// Outputs the current date and time, appending to a log file
const fs = require('fs');
const path = require('path');

const logFile = path.join(__dirname, '..', 'data', 'time-log.txt');
const line = new Date().toISOString() + '\n';

fs.appendFileSync(logFile, line);
console.log(line.trim());