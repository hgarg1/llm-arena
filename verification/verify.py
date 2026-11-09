from playwright.sync_api import sync_playwright
import os

def run():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        # Open the local file
        filepath = os.path.abspath("verification/repro.html")
        page.goto(f"file://{filepath}")

        # Wait a bit just in case scripts take time
        page.wait_for_timeout(2000)

        page.screenshot(path="verification/verification.png")
        print("Screenshot taken at verification/verification.png")
        browser.close()

if __name__ == "__main__":
    run()
