import type {Context} from '@deepseek-ai/cordis'

export const name = 'lifecycle-demo'

function heartbeat(ctx: Context){
	console.log('heartbeat plugin loading')
	ctx.effect(()=>{
		const timer = setInterval(()=> console.log('tick'), 200)
		return ()=> {
			clearInterval(timer)
			console.log('heartbeat cleaned up')
		}
	})
}

export function apply(ctx: Context){
	const fiber = ctx.plugin(heartbeat)
	ctx.effect(()=>{
		const timer = setTimeout(async ()=>{
			await fiber.dispose()
			console.log('dispose')
			process.exit(0)
		},700)
		return ()=> clearTimeout(timer)
	})
}
