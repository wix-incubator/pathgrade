// graders/check-brief.js
//
// Deterministic grader that checks artifacts/project-brief-*.md exists
// and contains the required sections. Outputs JSON to stdout.

const fs = require('fs');
const path = require('path');

const checks = [];
const artifactsDir = 'artifacts';

// Find project-brief-*.md files
let briefPath = null;
if (fs.existsSync(artifactsDir)) {
  const files = fs.readdirSync(artifactsDir)
    .filter(f => /^project-brief-.*\.md$/.test(f));
  if (files.length > 0) {
    briefPath = path.join(artifactsDir, files[0]);
  }
}

// Check 1: Brief file exists
checks.push({
  name: 'brief-exists',
  passed: briefPath !== null,
  message: briefPath
    ? 'Found ' + briefPath
    : 'No project-brief-*.md found in artifacts/'
});

if (!briefPath) {
  console.log(JSON.stringify({
    score: 0,
    details: '0/5 checks passed — brief file not found',
    checks
  }));
  process.exit(0);
}

const content = fs.readFileSync(briefPath, 'utf-8');

// Check 2: Has Context section
const hasContext = /^##\s+Context/m.test(content);
checks.push({
  name: 'has-context',
  passed: hasContext,
  message: hasContext ? 'Has Context section' : 'Missing Context section'
});

// Check 3: Has Direction section
const hasDirection = /^##\s+Direction/m.test(content);
checks.push({
  name: 'has-direction',
  passed: hasDirection,
  message: hasDirection ? 'Has Direction section' : 'Missing Direction section'
});

// Check 4: Has Goal section
const hasGoal = /^##\s+Goal/m.test(content);
checks.push({
  name: 'has-goal',
  passed: hasGoal,
  message: hasGoal ? 'Has Goal section' : 'Missing Goal section'
});

// Check 5: Has Target Group section
const hasTargetGroup = /^##\s+Target\s+Group/m.test(content);
checks.push({
  name: 'has-target-group',
  passed: hasTargetGroup,
  message: hasTargetGroup ? 'Has Target Group section' : 'Missing Target Group section'
});

// Calculate score
const passed = checks.filter(c => c.passed).length;
const score = parseFloat((passed / checks.length).toFixed(2));

console.log(JSON.stringify({ score, details: passed + '/' + checks.length + ' checks passed', checks }));
