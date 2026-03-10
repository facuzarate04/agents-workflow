import path from "node:path";
import { HUB_ROOT, readJsonFile, writeJsonFile } from "./utils.mjs";

const PROJECTS_CONFIG_PATH = path.join(HUB_ROOT, "config", "projects.json");

export async function loadProjects() {
  return (await readJsonFile(PROJECTS_CONFIG_PATH, { projects: {} })) || { projects: {} };
}

export async function saveProjects(data) {
  await writeJsonFile(PROJECTS_CONFIG_PATH, data);
}

export async function getProject(name) {
  const data = await loadProjects();
  const project = data.projects?.[name];
  if (!project) {
    return null;
  }
  return { name, ...project };
}

export async function addProject({ name, repos = {}, defaultRepo = null }) {
  const data = await loadProjects();
  data.projects[name] = {
    repos: repos || {},
    defaultRepo: defaultRepo || Object.keys(repos || {})[0] || null
  };
  await saveProjects(data);
  return data.projects[name];
}

export async function removeProject(name) {
  const data = await loadProjects();
  if (!data.projects[name]) {
    return false;
  }
  delete data.projects[name];
  await saveProjects(data);
  return true;
}

export async function addRepoToProject(projectName, { label, path: repoPath, type, description }) {
  const data = await loadProjects();
  const project = data.projects[projectName];
  if (!project) {
    throw new Error(`project not found: ${projectName}`);
  }
  project.repos[label] = {
    path: repoPath,
    type: type || "unknown",
    ...(description ? { description } : {})
  };
  if (!project.defaultRepo) {
    project.defaultRepo = label;
  }
  await saveProjects(data);
  return project.repos[label];
}

export async function removeRepoFromProject(projectName, label) {
  const data = await loadProjects();
  const project = data.projects[projectName];
  if (!project) {
    throw new Error(`project not found: ${projectName}`);
  }
  if (!project.repos[label]) {
    return false;
  }
  delete project.repos[label];
  if (project.defaultRepo === label) {
    project.defaultRepo = Object.keys(project.repos)[0] || null;
  }
  await saveProjects(data);
  return true;
}

export async function resolveProjectContext(projectName) {
  const project = await getProject(projectName);
  if (!project) {
    return null;
  }
  const defaultRepoLabel = project.defaultRepo;
  const defaultRepo = project.repos?.[defaultRepoLabel];
  return {
    name: project.name,
    repos: project.repos || {},
    defaultRepo: defaultRepoLabel,
    defaultRepoPath: defaultRepo?.path || null
  };
}
