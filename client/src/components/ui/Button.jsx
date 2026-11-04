import { Link } from 'react-router-dom';
import Icon from './Icon.jsx';
import { buttonClasses } from './classes.js';

/** <button> with the shared look. `loading` disables it and shows a spinner; keep the label. */
export function Button({
  variant,
  size,
  wrap,
  loading = false,
  disabled,
  className,
  type = 'button',
  children,
  ...props
}) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClasses({ variant, size, wrap, className })}
      {...props}
    >
      {loading && (
        <span
          aria-hidden="true"
          className="size-4 animate-spin rounded-full border-2 border-current border-r-transparent"
        />
      )}
      {children}
    </button>
  );
}

/** Router <Link> that looks like a button. */
export function LinkButton({ variant, size, className, children, icon, ...props }) {
  return (
    <Link className={buttonClasses({ variant, size, className })} {...props}>
      {children}
      {icon && <Icon name={icon} className="size-4" />}
    </Link>
  );
}