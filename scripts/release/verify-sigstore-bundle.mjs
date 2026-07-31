#!/usr/bin/env node
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { verify } from 'sigstore';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    try {
        const options = parseArgs(process.argv.slice(2));
        const statement = await verifyBundle(options);
        process.stdout.write(`${JSON.stringify(statement)}\n`);
    } catch (error) {
        process.stderr.write(`Sigstore cryptographic verification failed: ${message(error)}\n`);
        process.exitCode = 1;
    }
}

export async function verifyBundle(options, verifyImplementation = verify) {
    const bundle = readBundle(options.bundle);
    if (options.ctLogThreshold !== 1 || options.tlogThreshold !== 1) {
        throw new Error('CT and Rekor thresholds must both be exactly 1');
    }
    await verifyImplementation(bundle, {
        certificateIssuer: options.certificateIssuer,
        certificateIdentityURI: exactRegex(options.certificateIdentity),
        ctLogThreshold: options.ctLogThreshold,
        tlogThreshold: options.tlogThreshold,
    });
    const envelope = bundle.dsseEnvelope;
    if (!envelope || envelope.payloadType !== 'application/vnd.in-toto+json'
        || typeof envelope.payload !== 'string') {
        throw new Error('verified bundle does not contain an in-toto DSSE envelope');
    }
    try {
        return JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8'));
    } catch {
        throw new Error('verified DSSE payload is not JSON');
    }
}

function parseArgs(args) {
    const values = new Map();
    const allowed = new Set([
        '--bundle', '--certificate-identity', '--certificate-issuer',
        '--ct-log-threshold', '--tlog-threshold',
    ]);
    for (let index = 0; index < args.length; index += 2) {
        if (!allowed.has(args[index])) throw new Error(`unknown argument: ${args[index]}`);
        if (!args[index + 1]) throw new Error(`missing value for ${args[index]}`);
        values.set(args[index], args[index + 1]);
    }
    const required = option => {
        const value = values.get(option);
        if (!value) throw new Error(`${option} is required`);
        return value;
    };
    return {
        bundle: required('--bundle'),
        certificateIdentity: required('--certificate-identity'),
        certificateIssuer: required('--certificate-issuer'),
        ctLogThreshold: Number(required('--ct-log-threshold')),
        tlogThreshold: Number(required('--tlog-threshold')),
    };
}

function readBundle(filename) {
    try {
        const bundle = JSON.parse(fs.readFileSync(filename, 'utf8'));
        if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) throw new Error();
        return bundle;
    } catch {
        throw new Error('bundle must be a readable Sigstore bundle JSON object');
    }
}

function exactRegex(value) {
    return `^${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
}

function message(error) {
    return error instanceof Error ? error.message : String(error);
}
