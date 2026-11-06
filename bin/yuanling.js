#!/usr/bin/env node
// bin/yuanling.js —— CLI 入口。只做进程级包装，逻辑在 src/core/cli.js。
import { main } from '../src/core/cli.js'

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((err) => {
    console.error(`✗ ${err?.stack ?? err}`)
    process.exitCode = 1
  })
