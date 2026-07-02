class PathgradeJestReporterBridge {
    async onRunComplete(...args) {
        const mod = await import('./reporter.js');
        const Reporter = mod.default;
        const reporter = new Reporter();
        return await reporter.onRunComplete(...args);
    }
}

module.exports = PathgradeJestReporterBridge;
