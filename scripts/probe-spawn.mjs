// 探针：这台机器/这个沙箱到底能不能 spawn 子进程。
// 用法：node probe-spawn.mjs
import { spawn } from 'node:child_process'

const events = []
const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' })
child.on('error', (e) => events.push(`error:${e.code}`))
child.on('exit', (code, sig) => events.push(`exit:${code}/${sig}`))
setTimeout(() => {
  console.log('events =', events.join(' | ') || '(none)')
  console.log('verdict =', events.some((e) => e.startsWith('error:')) ? '禁止 spawn' : '可以 spawn')
}, 1200)
