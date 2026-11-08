import { useOutletContext } from "react-router";
import type { ProjectOutlet } from "../../types/projects";

export function useProject() {
  return useOutletContext<ProjectOutlet>().project;
}
