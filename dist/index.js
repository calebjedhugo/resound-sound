!function(e,t){"object"==typeof exports&&"object"==typeof module?module.exports=t():"function"==typeof define&&define.amd?define("resound-sound",[],t):"object"==typeof exports?exports["resound-sound"]=t():e["resound-sound"]=t()}(self,(()=>(()=>{"use strict";var e={d:(t,o)=>{for(var n in o)e.o(o,n)&&!e.o(t,n)&&Object.defineProperty(t,n,{enumerable:!0,get:o[n]})},o:(e,t)=>Object.prototype.hasOwnProperty.call(e,t),r:e=>{"undefined"!=typeof Symbol&&Symbol.toStringTag&&Object.defineProperty(e,Symbol.toStringTag,{value:"Module"}),Object.defineProperty(e,"__esModule",{value:!0})}},t={};e.r(t),e.d(t,{default:()=>s,noteConvert:()=>o});const o=e=>{try{let t=e.split(""),o=t[0].toUpperCase(),n=Number(t.pop()),s=1,r=0;for(;/#|b/.test(t[s]);)"#"===t[s]&&(t[0]=Object.keys((void 0).notesMeta)[((void 0).notesMeta[t[0]][1]+1)%12],r+=1),"b"==t[s]&&(t[0]=Object.keys((void 0).notesMeta)[((void 0).notesMeta[t[0]][1]+143)%12],r-=1),s+=1;return(void 0).notesMeta[o][1]+r<0&&(n-=1),(void 0).notesMeta[o][1]+r>11&&(n+=1),`${t[0]}/${n}`}catch(t){throw console.error(`${e} could not be converted.`),new Error(t.message)}};class n{constructor(){var e=window.AudioContext||window.webkitAudioContext,t=new e,o=t.createBuffer(1,1,44100),n=t.createBufferSource();n.buffer=o,n.connect(t.destination),n.start(0),n.disconnect(),t.close(),t=new e,this.soundscape=t}verifySoundUnlocked=()=>{if(!this.soundUnlocked&&this.soundscape){var e=this.soundscape.createBuffer(1,1,22050),t=this.soundscape.createBufferSource();t.buffer=e,t.connect(this.soundscape.destination),t.start(0),setTimeout((function(){t.playbackState!==t.PLAYING_STATE&&t.playbackState!==t.FINISHED_STATE||(this.soundUnlocked=!0)}),0)}};soundUnlocked=!1}const s=class{constructor(e="sine"){if(!window.resoundSoundscape){const e=new n;e.verifySoundUnlocked(),window.resoundSoundscape=e.soundscape}this.soundScape=window.resoundSoundscape,this.instrument=e}play({length:e=3e3}={}){const t=this.soundScape.createOscillator();t.type=this.instrument,t.connect(this.soundScape.destination),t.start(),setTimeout((()=>{t.stop()}),e)}};return t})()));