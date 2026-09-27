import { createRouter, createWebHistory } from "vue-router";
import HomePage from "./pages/HomePage.vue";
import HistoryPage from "./pages/HistoryPage.vue";
import SessionDetail from "./components/SessionDetail.vue";

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: "/", name: "home", component: HomePage },
    {
      path: "/history",
      name: "history",
      component: HistoryPage,
      children: [{ path: ":id", name: "history-item", component: SessionDetail }],
    },
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
});
