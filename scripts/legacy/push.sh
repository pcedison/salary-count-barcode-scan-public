#!/bin/bash
TOKEN=$(printenv GITHUB_TOKEN)
git remote set-url origin "https://${TOKEN}@github.com/pcedison/Salary-counting.git"
git push origin main
