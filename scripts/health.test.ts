import { GET } from "../src/app/api/health/route";

async function main() {
  try {
    const response = await GET();
    const body = await response.json();
    if (body.status === "ok") {
      console.log("PASS");
    } else {
      console.log("FAIL", JSON.stringify(body));
      process.exitCode = 1;
    }
  } catch (error) {
    console.log("FAIL", error);
    process.exitCode = 1;
  }
}

main();
