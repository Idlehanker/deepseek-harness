import type { Context } from '@deepseek-ai/cordis'

export const name = 'greeter-consumer'
export const inject = ['greeter']


export function apply(ctx: Context){
	console.log(ctx.greeter.greet('world'))
}
