export type SoundKind = 'boot' | 'click' | 'open' | 'close' | 'minimize' | 'restore' | 'error' | 'notify' | 'shutdown'

let audioContext: AudioContext | null = null

function context() {
  if (!audioContext) {
    const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioContextClass) return null
    audioContext = new AudioContextClass()
  }
  if (audioContext.state === 'suspended') void audioContext.resume()
  return audioContext
}

const melodies: Record<SoundKind, number[]> = {
  boot: [523, 659, 784, 1047, 784, 988], click: [660], open: [523, 784], close: [784, 523], minimize: [440, 330], restore: [392, 587],
  error: [196, 185], notify: [659, 784, 988], shutdown: [659, 523, 392, 330],
}

export function playSystemSound(kind: SoundKind, volume: number, enabled = true) {
  if (!enabled || volume <= 0) return
  const ctx = context()
  if (!ctx) return
  const now = ctx.currentTime
  const notes = melodies[kind]
  notes.forEach((frequency, index) => {
    const start = now + index * 0.095
    const duration = kind === 'click' ? 0.035 : 0.13
    const oscillator = ctx.createOscillator()
    const gain = ctx.createGain()
    oscillator.type = 'sine'
    oscillator.frequency.setValueAtTime(frequency, start)
    if (kind === 'error') oscillator.type = 'triangle'
    gain.gain.setValueAtTime(0.0001, start)
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, volume * (kind === 'click' ? 0.055 : 0.085)), start + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration)
    oscillator.connect(gain)
    gain.connect(ctx.destination)
    oscillator.start(start)
    oscillator.stop(start + duration + 0.01)
  })
}
