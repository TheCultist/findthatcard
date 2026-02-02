import { Suspense } from "react";
import SearchPage from "@/app/components/SearchPage";

export default function HomePage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-black" />}>
      <SearchPage />
    </Suspense>
  );
}
