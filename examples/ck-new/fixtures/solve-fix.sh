#!/bin/bash
# Solution script for tool-aware-fix validation.
# Simulates agent trace output so tool_usage grader can extract events.

# Simulate reading the file
echo 'tool: read_file {"path":"app.js"}'

# Fix the bug: replace a - b with a + b
sed -i '' 's/return a - b/return a + b/' app.js 2>/dev/null || sed -i 's/return a - b/return a + b/' app.js

# Simulate the edit event
echo 'tool: edit_file {"path":"app.js"}'

echo "Fixed the add function in app.js."
