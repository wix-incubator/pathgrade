// A simple calculator module with a bug.
function add(a, b) {
  return a - b; // BUG: should be a + b
}

function multiply(a, b) {
  return a * b;
}

module.exports = { add, multiply };
