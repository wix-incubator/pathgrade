const ts = require('typescript');

module.exports = {
    process(sourceText, sourcePath) {
        const output = ts.transpileModule(sourceText, {
            compilerOptions: {
                module: ts.ModuleKind.ESNext,
                target: ts.ScriptTarget.ESNext,
                esModuleInterop: true,
                sourceMap: false,
            },
            fileName: sourcePath,
        });

        return { code: output.outputText };
    },
};
