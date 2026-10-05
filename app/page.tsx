import { Suspense } from "react";
import SearchPage from "./components/SearchPage";

export default function HomePage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-background" />}>
      <SearchPage />
    </Suspense>
  );
}
