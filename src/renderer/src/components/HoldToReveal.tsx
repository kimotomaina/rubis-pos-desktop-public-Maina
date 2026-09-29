import { useEffect, useState, type ButtonHTMLAttributes, type InputHTMLAttributes } from 'react'
import { EyeIcon, EyeOffIcon } from './icons.js'

/**
 * Press-and-hold to show a secret; letting go hides it again.
 *
 * Deliberately not a toggle: a toggle left on puts the Shopify token or
 * the fiscal device password on screen for whoever walks past, so the
 * secret is only visible for as long as a finger or the mouse is held on
 * the icon. Every way a hold can end (release, cancel, losing pointer
 * capture, focus leaving the button, the window losing focus, the
 * component unmounting) hides it.
 *
 * @returns the current state and the props to spread onto the icon button
 */
export function useHoldToReveal(): {
  revealed: boolean
  /** Ends any hold at once, for when the icon disappears mid-hold and never sees its release. */
  hide: () => void
  holdProps: Pick<
    ButtonHTMLAttributes<HTMLButtonElement>,
    | 'onPointerDown'
    | 'onPointerUp'
    | 'onPointerCancel'
    | 'onLostPointerCapture'
    | 'onKeyDown'
    | 'onKeyUp'
    | 'onBlur'
    | 'onContextMenu'
  >
} {
  const [revealed, setRevealed] = useState(false)

  useEffect(() => {
    if (!revealed) return undefined
    const hide = (): void => setRevealed(false)
    window.addEventListener('blur', hide)
    return () => window.removeEventListener('blur', hide)
  }, [revealed])

  const hide = (): void => setRevealed(false)

  return {
    revealed,
    hide,
    holdProps: {
      onPointerDown: (event) => {
        // Keeps the release routed here even if the finger slides off the icon.
        event.currentTarget.setPointerCapture?.(event.pointerId)
        setRevealed(true)
      },
      onPointerUp: hide,
      onPointerCancel: hide,
      onLostPointerCapture: hide,
      onKeyDown: (event) => {
        if (!event.repeat && (event.key === ' ' || event.key === 'Enter')) {
          event.preventDefault()
          setRevealed(true)
        }
      },
      onKeyUp: hide,
      onBlur: hide,
      // A long press on a touch screen raises the context menu; that must not swallow the hold.
      onContextMenu: (event) => event.preventDefault()
    }
  }
}

const BUTTON_BASE =
  'flex shrink-0 touch-none select-none items-center justify-center rounded-lg text-slate-500 active:bg-slate-200 focus:outline-none focus-visible:ring-4 focus-visible:ring-rose-100'

/**
 * The icon button itself. Held down, it shows the open-eye-struck icon and
 * `revealed` is true; the caller decides what to reveal.
 *
 * @param {object} props
 * @param {boolean} props.revealed
 * @param {string} [props.className] — size and position
 * @returns {JSX.Element}
 */
export function HoldToRevealButton({
  revealed,
  className = 'h-12 w-12',
  ...holdProps
}: { revealed: boolean; className?: string } & ReturnType<typeof useHoldToReveal>['holdProps']) {
  return (
    <button
      type="button"
      aria-label="Hold to show"
      aria-pressed={revealed}
      className={`${BUTTON_BASE} ${className}`}
      {...holdProps}
    >
      {revealed ? <EyeOffIcon /> : <EyeIcon />}
    </button>
  )
}

/**
 * A secret's input with the hold-to-show icon inside its right edge. The
 * field is otherwise the plain input the caller describes: `className`
 * lands on the `<input>`, `wrapperClassName` on the box around it (margin,
 * grid cell), and everything else, `readOnly` and the keyboard-opening
 * handlers included, passes straight through.
 *
 * @param {object} props
 * @param {string} [props.wrapperClassName]
 * @returns {JSX.Element}
 */
export function PasswordField({
  className,
  wrapperClassName,
  ...input
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { wrapperClassName?: string }) {
  const { revealed, holdProps } = useHoldToReveal()
  return (
    <div className={`relative ${wrapperClassName ?? ''}`}>
      <input
        {...input}
        type={revealed ? 'text' : 'password'}
        className={className}
        // Inline so it beats the caller's own padding classes whatever order the stylesheet emits them in.
        style={{ paddingRight: '3.5rem' }}
      />
      <HoldToRevealButton
        revealed={revealed}
        className="absolute right-1 top-1/2 h-10 w-12 -translate-y-1/2"
        {...holdProps}
      />
    </div>
  )
}