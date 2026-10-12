import { type ReactNode } from "react";

type IconProps = { className?: string };

function Icon({ children, className }: IconProps & { children: ReactNode }) {
  return <svg aria-hidden="true" className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{children}</svg>;
}

export function MenuIcon(props: IconProps) {
  return <Icon {...props}><path d="M4 7h16M4 12h16M4 17h16" /></Icon>;
}

export function PanelIcon(props: IconProps) {
  return <Icon {...props}><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M9 4v16M12 8h4M12 12h4M12 16h4" /></Icon>;
}

export function BranchIcon(props: IconProps) {
  return <Icon {...props}><circle cx="6" cy="6" r="2" /><circle cx="18" cy="18" r="2" /><circle cx="18" cy="6" r="2" /><path d="M6 8v8a2 2 0 0 0 2 2h8M8 6h8" /></Icon>;
}

export function XIcon(props: IconProps) {
  return <Icon {...props}><path d="m6 6 12 12M18 6 6 18" /></Icon>;
}
