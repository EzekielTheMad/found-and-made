import { useEffect, useState, type ReactNode } from "react";

export function ResponsiveDisclosure({
  children,
  className,
  label,
}: {
  children: ReactNode;
  className: string;
  label: string;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const phone = window.matchMedia("(max-width: 600px)");
    const update = () => setOpen(!phone.matches);
    update();
    phone.addEventListener("change", update);
    return () => phone.removeEventListener("change", update);
  }, []);

  return (
    <details
      className={className}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      open={open}
    >
      <summary>{label}</summary>
      {children}
    </details>
  );
}
