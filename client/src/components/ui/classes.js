/** Joins class names, skipping falsy values. */
export const cx = (...parts) => parts.filter(Boolean).join(' ');

/** Text link inside running copy. */
export const linkClasses =
  'font-medium text-brand-600 underline-offset-2 hover:text-brand-700 hover:underline';

/** Shared look of text inputs, selects and textareas. */
export const inputClasses =
  'block w-full min-h-11 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm transition-colors placeholder:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500 aria-[invalid=true]:border-red-500 aria-[invalid=true]:focus:ring-red-500/30 sm:min-h-10';

const BUTTON_BASE =
  'inline-flex items-center justify-center gap-2 rounded-lg text-center font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50';

const BUTTON_VARIANTS = {
  primary: 'bg-brand-600 text-white shadow-sm hover:bg-brand-700 active:bg-brand-800',
  secondary:
    'border border-slate-300 bg-white text-slate-700 shadow-sm hover:border-slate-400 hover:bg-slate-50',
  ghost: 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
  danger: 'bg-red-600 text-white shadow-sm hover:bg-red-700 active:bg-red-800',
  'danger-outline':
    'border border-red-200 bg-white text-red-700 shadow-sm hover:border-red-300 hover:bg-red-50',
};

const BUTTON_SIZES = {
  sm: 'min-h-10 px-3 text-sm sm:min-h-9',
  md: 'min-h-11 px-4 text-sm sm:min-h-10',
  lg: 'min-h-12 px-6 text-base',
};

/** Class string for anything that should look like a button (a <button> or a router <Link>). */
/** `wrap` lets a long label break onto two lines instead of forcing the button wider. */
export const buttonClasses = ({ variant = 'primary', size = 'md', wrap = false, className } = {}) =>
  cx(BUTTON_BASE, !wrap && 'whitespace-nowrap', BUTTON_VARIANTS[variant], BUTTON_SIZES[size], className);

/** Responsive product grid: two columns on phones, up to four on wide screens. */
export const productGridClasses = 'grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 xl:grid-cols-4';