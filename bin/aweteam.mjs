#!/usr/bin/env node
import { runCli } from "../src/cli.mjs";

const exitCode = await runCli();
process.exitCode = exitCode;

