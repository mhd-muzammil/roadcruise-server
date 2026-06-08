import express from "express";

const router = express.Router();

router.get("/", (req, res) => {
  res.json({
    message: "Auth Route Working",
  });
});

export default router;
