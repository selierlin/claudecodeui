// Official Pi (pi.dev) logo, sourced from the pi.dev website download.
// A rounded dark tile with the white Pi mark; colors are fixed brand colors,
// so it renders identically in light and dark themes.

type PiLogoProps = {
  className?: string;
};

const PiLogo = ({ className = 'w-5 h-5' }: PiLogoProps) => (
  <svg
    viewBox="0 0 800 800"
    role="img"
    aria-label="Pi"
    className={className}
    xmlns="http://www.w3.org/2000/svg"
  >
    <rect width="800" height="800" rx="120" fill="#09090b" />
    <path
      fill="#fff"
      fillRule="evenodd"
      d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"
    />
    <path fill="#fff" d="M517.36 400H634.72V634.72H517.36Z" />
  </svg>
);

export default PiLogo;
