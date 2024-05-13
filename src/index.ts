import { Context, h, Schema, Service, Quester } from 'koishi'
import type Vits from '@initencounter/vits'
import { Speakers } from './list'

class Main extends Service implements Vits {
  static inject = {
    required: ['http']
  }

  constructor(ctx: Context, public config: Main.Config) {
    super(ctx, 'vits', true)
    ctx.command('fs-tts <content:text>', '语音生成', { checkArgCount: true, checkUnknown: true })
      .alias('say')
      .option('speaker', '--spkr [value:string]', { fallback: config.speaker })
      .option('chunk_length', '[value:number]', { fallback: config.chunk_length })
      .option('max_new_tokens', '[value:number]', { fallback: config.max_new_tokens })
      .option('top_p', '[value:number]', { fallback: config.top_p })
      .option('repetition_penalty', '[value:number]', { fallback: config.repetition_penalty })
      .option('temperature', '[value:number]', { fallback: config.temperature })
      .action(async ({ options }, input) => {
        if (/<.*\/>/gm.test(input)) return '输入的内容不是纯文本。'
        return await generate(ctx.http, options as Required<typeof options>, input)
      })
  }

  say(options: Vits.Result): Promise<h> {
    const speaker = typeof options.speaker_id === 'number'
      ? Speakers[options.speaker_id]
      : this.config.speaker
    return generate(this.ctx.http, { ...this.config, speaker }, options.input)
  }
}

function generate(http: Quester, config: Main.Config, input: string): Promise<h> {
  return new Promise((resolve, reject) => {
    const hash = Math.random().toString(36).substring(2)
    const api = 'wss://fs.firefly.matce.cn/queue/join'
    // What can I say
    const ws = http.ws(api)
    ws.addEventListener('message', e => {
      const parsed = JSON.parse(e.data)
      if (parsed.msg === 'send_hash') {
        ws.send(JSON.stringify({ fn_index: 1, session_hash: hash }))
      } else if (parsed.msg === 'send_data') {
        ws.send(JSON.stringify({
          data: [config.speaker],
          event_data: null,
          fn_index: 1,
          session_hash: hash
        }))
      } else if (parsed.msg === 'process_completed') {
        if (!parsed.success) return resolve(h.text('选择角色错误。'))
        const refName = parsed.output.data[0]
        const refText = parsed.output.data[1]
        const ws = http.ws(api)
        ws.addEventListener('message', e => {
          const parsed = JSON.parse(e.data)
          if (parsed.msg === 'send_hash') {
            ws.send(JSON.stringify({ fn_index: 2, session_hash: hash }))
          } else if (parsed.msg === 'send_data') {
            ws.send(JSON.stringify({
              data: [refName],
              event_data: null,
              fn_index: 2,
              session_hash: hash
            }))
          } else if (parsed.msg === 'process_completed') {
            const ref = parsed.output.data[0]
            const ws = http.ws(api)
            ws.addEventListener('message', e => {
              const parsed = JSON.parse(e.data)
              if (parsed.msg === 'send_hash') {
                ws.send(JSON.stringify({ fn_index: 4, session_hash: hash }))
              } else if (parsed.msg === 'send_data') {
                const { speaker, chunk_length, max_new_tokens, top_p, repetition_penalty, temperature } = config
                ws.send(JSON.stringify({
                  data: [
                    input,
                    true,
                    {
                      ...ref,
                      data: `https://fs.firefly.matce.cn/file=${ref.name}`
                    },
                    refText,
                    max_new_tokens,
                    chunk_length,
                    top_p,
                    repetition_penalty,
                    temperature,
                    speaker
                  ],
                  event_data: null,
                  fn_index: 4,
                  session_hash: hash
                }))
              } else if (parsed.msg === 'process_completed') {
                if (!parsed.success) return resolve(h.text('语音生成失败。'))
                const { data, duration } = parsed.output
                const url = `https://fs.firefly.matce.cn/file=${data[0].name}`
                resolve(h.audio(url, { type: 'voice', duration }))
              }
            })
            ws.addEventListener('error', err => reject(err))
          }
        })
        ws.addEventListener('error', err => reject(err))
      }
    })
    ws.addEventListener('error', err => reject(err))
  })
}

namespace Main {
  // https://github.com/fishaudio/fish-speech/blob/46594de3bf436ee2b8f45d60222675edc60a4fb6/tools/webui.py#L202
  export interface Config {
    speaker: string
    chunk_length: number
    max_new_tokens: number
    top_p: number
    repetition_penalty: number
    temperature: number
  }

  // https://github.com/fishaudio/fish-speech/blob/46594de3bf436ee2b8f45d60222675edc60a4fb6/fish_speech/i18n/locale/zh_CN.json
  export const Config: Schema<Config> = Schema.object({
    speaker: Schema.union(Speakers).default('三月七_ZH').description('说话人'),
    chunk_length: Schema.number().min(0).max(512).step(8).role('slider').default(48).description(
      '迭代提示长度，0 表示关闭',
    ),
    max_new_tokens: Schema.number().min(0).max(2048).step(8).role('slider').default(0).description(
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
  })
}

export default Main
