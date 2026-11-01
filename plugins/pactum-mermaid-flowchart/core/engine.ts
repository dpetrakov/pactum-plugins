// Version of the diagram layout engine (W-06f): stored with each personal layout gesture as a condition of applicability;
// a separate module so the host does not bundle the layout code to know it. route-2 (EP-081-T03, D39): node cards are
// larger (500-weight labels, padding 18/11) and dagre spacing wider, so automatic positions differ from route-1.
export const LAYOUT_ENGINE_VERSION = "dagre-3.1.1+route-2";
