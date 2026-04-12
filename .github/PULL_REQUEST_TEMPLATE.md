## Summary

Describe the change at a high level.

## Validation

Mark the checks you ran:

- [ ] `git diff --check`
- [ ] `npm run verify:release`
- [ ] targeted tests for the changed area
- [ ] docs updated where behavior or operations changed

## Release and Risk Review

- [ ] this change does not add plaintext secrets, personal data, or internal-only operational notes
- [ ] env, deployment, or callback URL changes are documented
- [ ] the version bump is appropriate for the scope of the change
- [ ] rollback or operator impact is described if relevant

## Additional Notes

Call out anything reviewers should pay extra attention to.
