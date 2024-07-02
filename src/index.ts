import { Context, h, Schema, Service, Dict, noop } from 'koishi'
import type Vits from '@initencounter/vits'
import { Speakers } from './list'

class Main extends Service implements Vits {
  static inject = {
    required: ['http']
  }

  constructor(ctx: Context, public config: Main.Config) {
    super(ctx, 'vits', true)
    ctx.command('fs-tts <content:text>', '语音生成', { checkUnknown: true })
      .alias('say')
      .option('speaker', '--spkr [value:string]', { fallback: config.speaker })
      .option('chunk_length', '[value:number]', { fallback: config.chunk_length })
      .option('max_new_tokens', '[value:number]', { fallback: config.max_new_tokens })
      .option('top_p', '[value:number]', { fallback: config.top_p })
      .option('repetition_penalty', '[value:number]', { fallback: config.repetition_penalty })
      .option('temperature', '[value:number]', { fallback: config.temperature })
      .action(async ({ options }, input) => {
        if (!input) return '内容未输入。'
        if (/<.*\/>/gm.test(input)) return '输入的内容不是纯文本。'
        return await generate(ctx, { ...this.config, ...options }, input)
      })
  }

  say(options: Vits.Result): Promise<h> {
    const speaker = typeof options.speaker_id === 'number'
      ? Speakers[options.speaker_id]
      : this.config.speaker
    return generate(this.ctx, { ...this.config, speaker }, options.input)
  }
}

function request(ctx: Context, session_hash: string, fn_index: number, data: any[]): Promise<Dict> {
  return new Promise((resolve, reject) => {
    let resolved = false
    const socket = ctx.http.ws('wss://fs.firefly.matce.cn/queue/join')
    socket.addEventListener('message', e => {
      const parsed = JSON.parse(e.data)
      if (parsed.msg === 'send_hash') {
        socket.send(JSON.stringify({ fn_index, session_hash }))
      } else if (parsed.msg === 'send_data') {
        socket.send(JSON.stringify({
          data,
          event_data: null,
          fn_index,
          session_hash
        }))
      } else if (parsed.msg === 'process_completed') {
        resolved = true
        resolve(parsed)
      }
    })
    socket.addEventListener('close', e => {
      if (!resolved) {
        reject(`code ${e.code}`)
      }
    })
    socket.addEventListener('error', noop)
  })
}

async function generate(ctx: Context, config: Main.Config, input: string): Promise<h> {
  const hash = Math.random().toString(36).substring(2)
  const fn1 = await request(ctx, hash, 1, [config.speaker])
  if (!fn1.success) return h.text('选择角色错误。')
  const refText = fn1.output.data[1]
  const fn2 = await request(ctx, hash, 2, [fn1.output.data[0]])
  if (!fn2.success) return h.text('获取参考失败。')
  const refAudio = {
    ...fn2.output.data[0],
    data: `https://fs.firefly.matce.cn/file=${fn2.output.data[0].name}`
  }
  let count = 0
  while (true) {
    const fn4 = await request(ctx, hash, 4, [
      input,
      true,
      refAudio,
      refText,
      config.max_new_tokens,
      config.chunk_length,
      config.top_p,
      config.repetition_penalty,
      config.temperature,
      config.speaker
    ])
    if (!fn4.success) {
      if (++count <= config.maxRetryCount) {
        continue
      }
      return h.text('语音生成失败。')
    }
    const { data, duration } = fn4.output
    const url = `https://fs.firefly.matce.cn/file=${data[0].name}`
    return h.audio(url, { type: 'voice', duration })
  }
}

namespace Main {
  // https://github.com/fishaudio/fish-speech/blob/46594de3bf436ee2b8f45d60222675edc60a4fb6/tools/webui.py#L202
  export interface ParamConfig {
    speaker: string
    chunk_length: number
    max_new_tokens: number
    top_p: number
    repetition_penalty: number
    temperature: number
  }

  export interface Config extends ParamConfig {
    maxRetryCount: number
  }

  // https://github.com/fishaudio/fish-speech/blob/46594de3bf436ee2b8f45d60222675edc60a4fb6/fish_speech/i18n/locale/zh_CN.json
  export const Config: Schema<Config> = Schema.intersect([
    Schema.object({
      speaker: Schema.union(Speakers).default('三月七_ZH').description('说话人'),
      chunk_length: Schema.number().min(0).max(512).step(8).role('slider').default(88).description(
        '迭代提示长度，0 表示关闭',
      ),
      max_new_tokens: Schema.number().min(0).max(4096).step(8).role('slider').default(0).description(
        '每批最大令牌数，0 表示无限制',
      ),
      top_p: Schema.number().min(0).max(1).step(0.01).role('slider').default(0.7).description(
        'Top-P',
      ),
      repetition_penalty: Schema.number().min(0).max(2).step(0.01).role('slider').default(1.5).description(
        '重复惩罚',
      ),
      temperature: Schema.number().min(0).max(2).step(0.01).role('slider').default(0.7).description(
        'Temperature',
      )
    }).description('参数设置'),
    Schema.object({
      maxRetryCount: Schema.natural().default(3).description('语音生成失败时最大的重试次数。')
    }).description('高级设置'),
  ])
}

export default Main
