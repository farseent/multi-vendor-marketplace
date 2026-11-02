/** Shared Mongoose toJSON options: the API returns `id`, never `_id` or `__v` (PROJECT_MASTER 6). */
export const toJSON = {
  virtuals: true,
  versionKey: false,
  transform(_doc, ret) {
    delete ret._id;
    return ret;
  },
};

/** An integer paise amount, never negative (D5). */
export const paise = { type: Number, required: true, min: 0, validate: Number.isInteger };
