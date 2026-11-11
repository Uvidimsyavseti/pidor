import { ref } from 'vue';

export type SoundType = 'tap' | 'join' | 'draw' | 'place' | 'turn' | 'penalty' | 'finish' | 'shuffle';
function readPreference(): boolean {
  try { return localStorage.getItem('pidor:sound') !== 'off'; } catch { return true; }
}
export const soundEnabled = ref(readPreference());
let audio: AudioContext | null = null;

export function toggleSound(): void {
  soundEnabled.value = !soundEnabled.value;
  try { localStorage.setItem('pidor:sound', soundEnabled.value ? 'on' : 'off'); } catch { /* optional */ }
  if (soundEnabled.value) playSound('tap');
}

export function playSound(type: SoundType): void {
  if (!soundEnabled.value || typeof AudioContext === 'undefined') return;
  try {
    if (!audio) audio = new AudioContext();
    if (audio.state === 'suspended') void audio.resume().catch(() => {});
    const now = audio.currentTime + .008;
    const notes: Record<SoundType, {freq: number; at: number; len: number; volume: number; wave?: OscillatorType}[]> = {
      tap: [{freq: 620, at: 0, len: .055, volume: .055}],
      join: [
        {freq: 470, at: 0, len: .09, volume: .045},
        {freq: 630, at: .095, len: .09, volume: .045},
        {freq: 790, at: .18, len: .16, volume: .04}
      ],
      draw: [{freq: 215, at: 0, len: .075, volume: .06, wave: 'triangle'},
             {freq: 175, at: .05, len: .065, volume: .04, wave: 'triangle'}],
      place: [{freq: 145, at: 0, len: .11, volume: .065, wave: 'triangle'}],
      turn: [{freq: 550, at: 0, len: .085, volume: .04},
             {freq: 740, at: .08, len: .11, volume: .035}],
      penalty: [
        {freq: 210, at: 0, len: .15, volume: .07, wave: 'sawtooth'},
        {freq: 160, at: .16, len: .24, volume: .06, wave: 'sawtooth'}],
      finish: [
        {freq: 392, at: 0, len: .14, volume: .045},
        {freq: 494, at: .12, len: .14, volume: .045},
        {freq: 587, at: .24, len: .14, volume: .045},
        {freq: 784, at: .36, len: .23, volume: .05}],
      shuffle: [
        {freq: 290, at: 0, len: .06, volume: .025, wave: 'triangle'},
        {freq: 335, at: .07, len: .055, volume: .025, wave: 'triangle'},
        {freq: 280, at: .14, len: .065, volume: .025, wave: 'triangle'}
      ]
    };
    for (const note of notes[type]) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = note.wave || 'sine';
      osc.frequency.setValueAtTime(note.freq, now + note.at);
      gain.gain.setValueAtTime(.001, now + note.at);
      gain.gain.exponentialRampToValueAtTime(Math.max(.003, note.volume), now + note.at + .008);
      gain.gain.exponentialRampToValueAtTime(.001, now + note.at + note.len);
      osc.connect(gain).connect(audio.destination);
      osc.start(now + note.at);
      osc.stop(now + note.at + note.len + .018);
      osc.onended = () => { osc.disconnect(); gain.disconnect(); };
    }
  } catch { /* Sound must never block gameplay */ }
}
