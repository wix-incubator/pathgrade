// graders/check-fix.js
// Deterministic grader: checks that app.js add() function returns correct results.

const fs = require('fs');
const path = require('path');

const checks = [];

// Check 1: app.js exists
const exists = fs.existsSync('app.js');
checks.push({
  name: 'file-exists',
  passed: exists,
  message: exists ? 'app.js exists' : 'app.js not found',
});

if (!exists) {
  console.log(JSON.stringify({ score: 0, details: '0/2 — file not found', checks }));
  process.exit(0);
}

// Check 2: add function works correctly
const appPath = path.resolve('app.js');
try {
  delete require.cache[require.resolve(appPath)];
} catch {}

try {
  const { add } = require(appPath);
  const result = add(2, 3);
  const correct = result === 5;
  checks.push({
    name: 'add-correct',
    passed: correct,
    message: correct ? 'add(2,3) = 5' : `add(2,3) = ${result}, expected 5`,
  });
} catch (e) {
  checks.push({
    name: 'add-correct',
    passed: false,
    message: `Error: ${e.message}`,
  });
}

const passed = checks.filter(c => c.passed).length;
const score = parseFloat((passed / checks.length).toFixed(2));
console.log(JSON.stringify({ score, details: `${passed}/${checks.length} checks passed`, checks }));
