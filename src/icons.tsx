import type { ReactNode } from 'react'

const Icon = ({ children }: { children: ReactNode }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
    {children}
  </svg>
)

export const icons = {
  select: <Icon><path d="M4 2l9 6.5-4 .8 2.3 4.2-1.6.9-2.3-4.2L4 13z" /></Icon>,
  rect: <Icon><rect x="2.5" y="3.5" width="11" height="9" /></Icon>,
  ellipse: <Icon><ellipse cx="8" cy="8" rx="5.5" ry="4.5" /></Icon>,
  polygon: <Icon><path d="M8 2l5.2 3v6L8 14l-5.2-3V5z" /></Icon>,
  pen: <Icon><path d="M2.5 13.5l1-3.5 7.5-7.5 2.5 2.5-7.5 7.5zM9.5 4l2.5 2.5" /></Icon>,
  text: <Icon><path d="M3 3.5h10M8 3.5v10M6 13.5h4" /></Icon>,
  left: <Icon><path d="M2 1.5v13" /><rect x="4" y="3" width="10" height="4" /><rect x="4" y="9" width="6" height="4" /></Icon>,
  centerX: <Icon><path d="M8 1.5v13" /><rect x="3" y="3" width="10" height="4" /><rect x="5" y="9" width="6" height="4" /></Icon>,
  right: <Icon><path d="M14 1.5v13" /><rect x="2" y="3" width="10" height="4" /><rect x="6" y="9" width="6" height="4" /></Icon>,
  top: <Icon><path d="M1.5 2h13" /><rect x="3" y="4" width="4" height="10" /><rect x="9" y="4" width="4" height="6" /></Icon>,
  centerY: <Icon><path d="M1.5 8h13" /><rect x="3" y="3" width="4" height="10" /><rect x="9" y="5" width="4" height="6" /></Icon>,
  bottom: <Icon><path d="M1.5 14h13" /><rect x="3" y="2" width="4" height="10" /><rect x="9" y="6" width="4" height="6" /></Icon>,
}
