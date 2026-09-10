type WorkbuddyLogoProps = {
  className?: string;
};

const WorkbuddyLogo = ({ className = 'w-5 h-5' }: WorkbuddyLogoProps) => (
  <img
    src="/workbuddy.svg"
    alt="WorkBuddy"
    className={`${className} object-contain`}
  />
);

export default WorkbuddyLogo;
