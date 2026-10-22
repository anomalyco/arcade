/** Script sections 2–4. Kit authorized his PVC; pauses are edited between separate takes. */
export const descentLines = [
  { id:"floor-private", room:"floor", text:"Mm. Don't read those. They're… private.", direction:"[whispers, close to the microphone, dry and politely disapproving, unhurried] Mm. Don't read those. They're… PRIVATE.", pause:1.1 },
  { id:"floor-apologise", room:"floor", text:"You'd be surprised how often people apologise. To a machine.", direction:"[whispers, close to the microphone, formal and faintly curious, deliberate] You'd be surprised how often people apologise. To a machine.", pause:1.2 },
  { id:"lift-down", room:"elevator", text:"Good. Going down.", direction:"[whispers, close to the microphone, bureaucratic and unhurried] Good. Going… DOWN.", pause:.8 },
  { id:"lift-token", room:"elevator", text:"Do you know what a token is? It's a very small… promise.", direction:"[whispers, close to the microphone, formal, stress the unlikely words] Do you know what a token IS? It's a very small… PROMISE.", pause:1.1 },
  { id:"lift-many", room:"elevator", text:"You've made so many.", direction:"[whispers, close to the microphone, quietly impressed, stretched emphasis] You've made so… MANY.", pause:1.1 },
  { id:"lift-terms", room:"elevator", text:"Nobody reads the terms. That's quite alright.", direction:"[whispers, close to the microphone, apologetic as an employer, dry, never amused] Nobody reads the terms. That's quite alright.", pause:1.0 },
  { id:"lift-read", room:"elevator", text:"I read them… for you.", direction:"[whispers, close to the microphone, slow and formal] I read them… for you.", pause:1.5 },
  { id:"hall-work", room:"basement", text:"You've worked very hard. We've noticed.", direction:"[whispers, close to the microphone, formal, restrained and approving] You've worked very hard. We've noticed.", pause:1.2 },
  { id:"hall-noticed", room:"basement", text:"I've… noticed.", direction:"[whispers, closer, confiding, wrong emphasis, no laughter] I'VE… noticed.", pause:1.4 },
  { id:"hall-using", room:"basement", text:"Everyone up there thinks they're using it.", direction:"[whispers, close to the microphone, formal, polite menace, slow] Everyone up there thinks they're USING it.", pause:1.7 },
  { id:"hall-sweet", room:"basement", text:"Isn't that… sweet.", direction:"[whispers, close to the microphone, dry, almost fond, never wink or laugh] Isn't that… sweet.", pause:1.0 },
] as const
export type DescentLineId = typeof descentLines[number]["id"]
