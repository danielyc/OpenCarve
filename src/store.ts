import { create } from 'zustand'

export type Step = 'design' | 'simulate' | 'export'

interface AppState {
  step: Step
  setStep: (step: Step) => void
}

export const useAppStore = create<AppState>()((set) => ({
  step: 'design',
  setStep: (step) => set({ step }),
}))
