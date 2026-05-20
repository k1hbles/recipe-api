// SETUP

const express = require('express');
const cors = require('cors');
// middleware third party NPM package not covered in class (rubcric)
const morgan = require('morgan');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { ObjectId } = require('mongodb');
require('dotenv').config();

const { connect } = require('./db');

const mongoUri = process.env.MONGO_URI;
const dbname = process.env.DB_NAME || 'recipe_book';

const app = express();

app.use(express.json());

app.use(cors());

app.use(morgan('dev'));

// Generate JWT
const generateAccessToken = (id, email) => {
    return jwt.sign({
        'user_id': id,
        'email': email
    }, process.env.TOKEN_SECRET, {
        expiresIn: '7d'
    });
};

// MIDDLEWARE verify JWT
const verifyToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.sendStatus(403);

    jwt.verify(token, process.env.TOKEN_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
}

// Main

async function main() {
    const db = await connect(mongoUri, dbname);

    app.get('/', function (req, res) {
        res.json({ message: 'Recipes API is running' });
    });

    // ROUTES

    // POST /users - Register
    app.post('/users', async function (req, res) {
        try {
            const { email, password } = req.body;

            // Validate
            if (!email || !password) {
                return res.status(400).json({ error: 'Email and password are required' });
            }

            // Email must contain @
            if (!email.includes('@') || !email.includes('.')) {
                return res.status(400).json({ error: 'Invalid email format' });
            }

            // Password must be atleast 6 characters
            if (password.length < 6) {
                return res.status(400).json({ error: 'Password must be atleast 6 characters' });
            }

            // Check if email exists
            const existing = await db.collection('users').findOne({ email: email });
            if (existing) {
                return res.status(409).json({ error: 'Email already registered' });
            }

            const result = await db.collection('users').insertOne({
                email: email,
                password: await bcrypt.hash(password, 12)
            });

            res.status(201).json({
                message: 'Account created',
                userId: result.insertedId
            });
        } catch (error) {
            console.error('Register error', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // POST login and JWT
    app.post('/login', async (req, res) => {
        try {
            const { email, password } = req.body;

            if (!email || !password) {
                return res.status(400).json({ error: 'Email and password are required' });
            }
            const user = await db.collection('users').findOne({ email: email });
            if (!user) {
                return res.status(404).json({ error: 'User not found' });
            }
            const isPasswordValid = await bcrypt.compare(password, user.password);
            if (!isPasswordValid) {
                return res.status(401).json({ error: 'Invalid password' });
            }
            const accessToken = generateAccessToken(user._id, user.email);
            res.json({ accessToken: accessToken });
        } catch (error) {
            console.error('Login error', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // RECIPE ROUTES

    // GET /recipes & using Mongo
    app.get('/recipes', async (req, res) => {
        try {
            const { recipeName, cuisine, tags, ingredients, minPrepTime, maxPrepTime } = req.query;

            const criteria = {};

            if (recipeName) {
                criteria.name = { $regex: recipeName, $options: 'i' };
            }
            if (cuisine) {
                criteria['cuisine.name'] = { $regex: cuisine, $options: 'i' };
            }
            if (tags) {
                criteria['tags.name'] = { $in: tags.split(',') };
            }
            if (ingredients) {
                criteria['ingredients.name'] = {
                    $all: ingredients.split(',').map(i => new RegExp(i, 'i'))
                };
            }
            if (minPrepTime || maxPrepTime) {
                criteria.prepTime = {};
                if (minPrepTime) criteria.prepTime.$gte = Number(minPrepTime);
                if (maxPrepTime) criteria.prepTime.$lte = Number(maxPrepTime);
            }

            const recipes = await db.collection('recipes').find(criteria).project({
                name: 1,
                'cuisine.name': 1,
                'tags.name': 1,
                prepTime: 1
            }).toArray();

            res.json({ recipes });
        } catch (error) {
            console.error('Fetch recipes error', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // GET /recipes/:id
    app.get('/recipes/:id', async (req, res) => {
        try {
            const id = req.params.id;

            const recipe = await db.collection('recipes').findOne({ _id: new ObjectId(id) });
            if (!recipe) {
                return res.status(404).json({ error: 'Recipe not Found' });
            }
            res.json(recipe);
        } catch (error) {
            console.error('Fetch recipe error:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // POST /recipes 
    // verifyToken
    app.post('/recipes', verifyToken, async (req, res) => {
        try {
            const { name, cuisine, prepTime, cookTime, servings, ingredients, instructions, tags } = req.body;

            if (!name || !cuisine || !ingredients || !instructions || !tags) {
                return res.status(400).json({ error: 'Missing required fields' });
            }

            // Prep time cannot be negative
            if (prepTime < 0 || cookTime < 0) {
                return res.status(400).json({ error: 'Prep and cook time cannot be negative' });
            }

            // Servings cannot be less than 1
            if (servings < 1) {
                return res.status(400).json({ error: 'Must include atleast one serving' })
            }

            // Look up cuisines
            const cuisineDoc = await db.collection('cuisines').findOne({ name: cuisine });
            if (!cuisineDoc) {
                return res.status(400).json({ error: ' Invalid cuisine' });
            }

            const tagDocs = await db.collection('tags').find({ name: { $in: tags } }).toArray();
            if (tagDocs.length !== tags.length) {
                return res.status(400).json({ error: 'One or more invalid tags' });
            }

            const newRecipe = {
                name, cuisine: { _id: cuisineDoc._id, name: cuisineDoc.name },
                prepTime,
                cookTime,
                servings,
                ingredients,
                instructions,
                tags: tagDocs.map(tag => ({ _id: tag._id, name: tag.name })),
                reviews: [],
                // assignment requirement
                ownerId: new ObjectId(req.user.user_id),
                ownerEmail: req.user.email
            };

            const result = await db.collection('recipes').insertOne(newRecipe);
            res.status(201).json({
                message: 'Recipe created successfully',
                recipeId: result.insertedId
            });
        } catch (error) {
            console.error('Create recipe error:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // PUT /recipes/:id Update a recipe
    app.put('/recipes/:id', verifyToken, async (req, res) => {
        try {
            const recipeId = req.params.id;
            const { name, cuisine, prepTime, cookTime, servings, ingredients, instructions, tags } = req.body;

            if (!name || !cuisine || !ingredients || !instructions || !tags) {
                return res.status(400).json({ error: 'Missing required fields' });
            }

            // Prep time cannot be negative
            if (prepTime < 0 || cookTime < 0) {
                return res.status(400).json({ error: 'Prep and cook time cannot be negative' });
            }

            // Servings cannot be less than 1
            if (servings < 1) {
                return res.status(400).json({ error: 'Must include atleast one serving' })
            }

            const existing = await db.collection('recipes').findOne({ _id: new ObjectId(recipeId) });
            if (!existing) {
                return res.status(404).json({ error: 'Recipe not found' });
            }
            if (existing.ownerId.toString() !== req.user.user_id) {
                return res.status(403).json({ error: 'You are not the owner of this recipe' });
            }

            const cuisineDoc = await db.collection('cuisines').findOne({ name: cuisine });
            if (!cuisineDoc) {
                return res.status(400).json({ error: 'Invalid cuisine' });
            }
            const tagDocs = await db.collection('tags').find({ name: { $in: tags } }).toArray();
            if (tagDocs.length !== tags.length) {
                return res.status(400).json({ error: 'One or more invalid tags ' });
            }

            const updatedRecipe = {
                name,
                cuisine: { _id: cuisineDoc._id, name: cuisineDoc.name },
                prepTime,
                cookTime,
                servings,
                ingredients,
                instructions,
                tags: tagDocs.map(tag => ({ _id: tag._id, name: tag.name }))
            };

            await db.collection('recipes').updateOne(
                { _id: new ObjectId(recipeId) },
                { $set: updatedRecipe }
            );
            res.json({ message: 'Recipe updated successfully' });
        } catch (error) {
            console.error('Updated recipe error:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // DELETE
    app.delete('/recipes/:id', verifyToken, async (req, res) => {
        try {
            const recipeId = req.params.id;

            const existing = await db.collection('recipes').findOne({ _id: new ObjectId(recipeId) });
            if (!existing) {
                return res.status(404).json({ error: 'Recipe not found' });
            }
            if (existing.ownerId.toString() !== req.user.user_id) {
                return res.status(403).json({ error: 'You are not the owner of this recipe' });
            }

            await db.collection('recipes').deleteOne({ _id: new ObjectId(recipeId) });
            res.json({ message: 'Recipe deleted successfully' });
        } catch (error) {
            console.error('Delete recipe error:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // REVIEW ROUTES

    // POST /recipes/:id/reviews
    app.post('/recipes/:id/reviews', verifyToken, async (req, res) => {
        try {
            const recipeId = req.params.id;
            const { rating, comment } = req.body;

            if (!rating || !comment) {
                return res.status(400).json({ error: 'Rating and comment are required' });
            }

            const newReview = {
                review_id: new ObjectId(),
                userId: new ObjectId(req.user.user_id),
                userEmail: req.user.email,
                rating: Number(rating),
                comment,
                date: new Date()
            };

            const result = await db.collection('recipes').updateOne(
                { _id: new ObjectId(recipeId) },
                { $push: { reviews: newReview } }
            );

            if (result.matchedCount === 0) {
                return res.status(404).json({ error: 'Recipe not found' });
            }

            res.status(201).json({
                message: 'Review added successfully',
                reviewId: newReview.review_id
            });
        } catch (error) {
            console.error('Add review error:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    });


    // PUT /recipes/:recipeId/reviews/:reviewId 
    app.put('/recipes/:recipeId/reviews/:reviewId', verifyToken, async (req, res) => {
        try {
            const recipeId = req.params.recipeId;
            const reviewId = req.params.reviewId;
            const { rating, comment } = req.body;

            if (!rating || !comment) {
                return res.status(400).json({ error: 'Rating and comment are required' });
            }

            if (rating < 1 || rating > 5) {
                return res.status(400).json({ error: 'Rating must be between 1 and 5' });
            }
            const recipe = await db.collection('recipes').findOne({ _id: new ObjectId(recipeId) });
            if (!recipe) {
                return res.status(404).json({ error: 'Recipe not found' });
            }
            const review = recipe.reviews.find(r => r.review_id.toString() === reviewId);
            if (!review) {
                return res.status(404).json({ error: 'Review not found' });
            }
            if (review.userId.toString() !== req.user.user_id) {
                return res.status(403).json({ error: 'You are not the owner of this review' });
            }
            await db.collection('recipes').updateOne(
                {
                    _id: new ObjectId(recipeId),
                    'reviews.review_id': new ObjectId(reviewId)
                },
                {
                    $set: {
                        'reviews.$.rating': Number(rating),
                        'reviews.$.comment': comment,
                        'reviews.$.date': new Date()
                    }
                }
            );
            res.json({ message: 'Review updated' });
        } catch (error) {
            console.error('Update review error:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // PATCH (referenced from AI)
    app.patch('/recipes/:id', verifyToken, async (req, res) => {
        try {
            const recipeId = req.params.id;

            const existing = await db.collection('recipes').findOne({ _id: new ObjectId(recipeId) });
            if (!existing) {
                return res.status(404).json({ error: 'Recipe not found' });
            }
            if (existing.ownerId.toString() !== req.user.user_id) {
                return res.status(403).json({ error: 'You are not the owner of this recipe' });
            }

            const updates = {};

            if (req.body.name) updates.name = req.body.name;
            if (req.body.ingredients) updates.ingredients = req.body.ingredients;
            if (req.body.instructions) updates.instructions = req.body.instructions;

            if (req.body.prepTime !== undefined) {
                if (req.body.prepTime < 0) {
                    return res.status(400).json({ error: 'Prep time cannot be negative' });
                }
                updates.prepTime = req.body.prepTime
            }
            if (req.body.cookTime !== undefined) {
                if (req.body.cookTime < 0) {
                    return res.status(400).json({ error: 'Cooking time cannot be negative' });
                }
                updates.cookTime = req.body.cookTime;
            }
            if (req.body.servings !== undefined) {
                if (req.body.servings < 1) {
                    return res.status(400).json({ error: 'Servings must be atleast 1' });
                }
                updates.servings = req.body.servings;
            }
            if (req.body.cuisine) {
                const cuisineDoc = await db.collection('cuisines').findOne({ name: req.body.cuisine });
                if (!cuisineDoc) {
                    return res.status(400).json({ error: 'Invalid cuisine'});
                }
                updates.cuisine = { _id: cuisineDoc._id, name: cuisineDoc.name }; 
            }
            if (req.body.tags) {
                const tagDocs = await db.collection('tags').find({ name: { $in: req.body.tags } }).toArray();
                if (tagDocs.length !== req.body.tags.length) {
                    return res.status(400).json({ error: 'One or mre invalid tags' });
                }
                updates.tags = tagDocs.map(tags => ({ _id: tags._id, name: tags.name }));
            }

            if (Object.keys(updates).length ===0) {
                return res.status(400).json({ error: 'No fields provided to update'});
            }
            await db.collection('recipes').updateOne(
                { _id: new ObjectId(recipeId) },
                { $set: updates }
            );

            res.json({ message: 'Recipe patched success', updatedFields: Object.keys(updates) });
        } catch (error) {
            console.error('Patch recipe error', error);
            res.status(500).json({ error: 'Interna; server error' });
        }
    });

    // DELETE /recipes/:recipeId/reviews/:reviewid - Delete a review
    app.delete('/recipes/:recipeId/reviews/:reviewId', verifyToken, async (req, res) => {
        try {
            const recipeId = req.params.recipeId;
            const reviewId = req.params.reviewId;

            const recipe = await db.collection('recipes').findOne({ _id: new ObjectId(recipeId) });
            if (!recipe) {
                return res.status(404).json({ error: 'Recipe not found' });
            }

            const review = recipe.reviews.find(r => r.review_id.toString() === reviewId);
            if (!review) {
                return res.status(404).json({ error: 'Review not found' });
            }
            if (review.userId.toString() !== req.user.user_id) {
                return res.status(403).json({ error: 'You do not own this revoew' });
            }
            

            await db.collection('recipes').updateOne(
                { _id: new ObjectId(recipeId) },
                { $pull: { reviews: { review_id: new ObjectId(reviewId) } } }
            );

            res.json({ message: 'Review deleted successfully' });
        } catch (error) {
            console.error('Delete review error:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    });
}

main();

// start server
app.listen(8080, function () {
    console.log("Server has started on port 8080")
});


