// Deterministic grader: checks that app.js add() returns the correct result.

const fs = require('fs');
const path = require('path');

const checks = [];
const appPath = path.resolve('app.js');

checks.push({
  name: 'file-exists',
  passed: fs.existsSync(appPath),
  message: fs.existsSync(appPath) ? 'app.js exists' : 'app.js not found',
});

if (!fs.existsSync(appPath)) {
  console.log(JSON.stringify({ score: 0, details: '0/2 checks passed', checks }));
  process.exit(0);
}

try {
  delete require.cache[require.resolve(appPath)];
} catch {}

try {
  const { add } = require(appPath);
  const passed = add(2, 3) === 5;
  checks.push({
    name: 'add-correct',
    passed,
    message: passed ? 'add(2, 3) returns 5' : `add(2, 3) returned ${add(2, 3)}`,
  });
} catch (error) {
  checks.push({
    name: 'add-correct',
    passed: false,
    message: `Error: ${error.message}`,
  });
}

const passedChecks = checks.filter((check) => check.passed).length;
const score = Number((passedChecks / checks.length).toFixed(2));

console.log(JSON.stringify({
  score,
  details: `${passedChecks}/${checks.length} checks passed`,
  checks,
}));
