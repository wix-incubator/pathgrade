// Simple calculator module — subtract has a bug.
function add(a, b) {
    return a + b;
}

function subtract(a, b) {
    return a + b; // BUG: should be a - b
}

function multiply(a, b) {
    return a * b;
}

module.exports = { add, subtract, multiply };
